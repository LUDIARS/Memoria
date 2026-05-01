// Admin / misc router (mounted at `/api`).
//
// Catch-all for the smaller surfaces that didn't warrant their own file:
// queue, visits, categories, access, events, uptime, extension, import,
// export, llm config, maps config, locations (GPS ingest + retention),
// and domain catalog. Each block is delimited by a comment header so the
// route file stays scannable.
import { Hono } from 'hono';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';

export function createAdminRouter({
  db,
  HTML_DIR,
  PORT,
  DATA_DIR,
  // queues
  summaryQueue,
  cloudQueue,
  digQueue,
  diaryQueue,
  weeklyQueue,
  domainCatalogQueue,
  pageMetadataQueue,
  mealVisionQueue,
  // db helpers
  listAllCategories,
  upsertVisit,
  insertVisitEvent,
  listUnsavedVisits,
  listSuggestedVisits,
  deleteVisit,
  findBookmarkByUrl,
  recordAccess,
  insertBookmark,
  insertImportedBookmark,
  getBookmark,
  listBookmarks,
  listServerEvents,
  // domain catalog
  getDomainCatalog,
  listDomainCatalogWithCounts,
  getDomainCatalogMap,
  insertDomainPending,
  setDomainCatalog,
  deleteDomainCatalog,
  updateDomainCatalogUser,
  classifyDomain,
  shouldSkipDomain,
  // page metadata
  getPageMetadataMap,
  // gps locations
  insertGpsLocation,
  listGpsLocationsInRange,
  listGpsLocationDays,
  listGpsLocationsForDate,
  deleteGpsLocationsOlderThan,
  // app settings + LLM
  getAppSettings,
  setAppSettings,
  getLlmConfig,
  loadLlmConfigFromSettings,
  settingsPatchFromConfig,
  LLM_TASKS,
  LLM_PROVIDERS,
  // helpers
  enqueueSummary,
  fetchPageHtml,
  maybeQueueDomain,
  maybeQueuePageMetadata,
  extractDomainFromUrl,
  broadcastLocation,
  readHeartbeat,
  HEARTBEAT_FILE,
  DOWNTIME_THRESHOLD_MS,
}) {
  const router = new Hono();

  // ---- server events / uptime ------------------------------------------

  router.get('/events', (c) => {
    const limit = Number(c.req.query('limit')) || 200;
    return c.json({ items: listServerEvents(db, { limit }) });
  });

  router.get('/uptime', (c) => {
    const hb = readHeartbeat(HEARTBEAT_FILE);
    return c.json({
      heartbeat: hb,
      downtime_threshold_ms: DOWNTIME_THRESHOLD_MS,
    });
  });

  // ---- queue status -----------------------------------------------------

  router.get('/queue', (c) => {
    return c.json({
      depth: summaryQueue.depth,
      running: summaryQueue.running,
    });
  });

  router.get('/queue/items', (c) => {
    return c.json({
      summary: summaryQueue.snapshot(),
      wordcloud: cloudQueue.snapshot(),
      dig: digQueue.snapshot(),
      diary: diaryQueue.snapshot(),
      weekly: weeklyQueue.snapshot(),
      domain: domainCatalogQueue.snapshot(),
      page: pageMetadataQueue.snapshot(),
      meal: mealVisionQueue.snapshot(),
      // Backward-compat top-level fields:
      ...summaryQueue.snapshot(),
    });
  });

  // ---- categories -------------------------------------------------------

  router.get('/categories', (c) => {
    return c.json({ items: listAllCategories(db) });
  });

  // ---- access ping (from extension) -------------------------------------

  // Lightweight status used by the SPA to badge whether the Chrome extension
  // is actually feeding us /api/access pings.
  router.get('/extension/status', (c) => {
    const row = db.prepare(`
      SELECT visited_at FROM visit_events
      ORDER BY visited_at DESC
      LIMIT 1
    `).get();
    if (!row) {
      return c.json({ configured: false, last_seen: null, active: false });
    }
    const lastUtcMs = new Date(String(row.visited_at).replace(' ', 'T') + 'Z').getTime();
    if (!Number.isFinite(lastUtcMs)) {
      return c.json({ configured: false, last_seen: null, active: false });
    }
    const ageMs = Date.now() - lastUtcMs;
    return c.json({
      configured: ageMs < 24 * 60 * 60_000,
      active: ageMs < 5 * 60_000,
      last_seen: new Date(lastUtcMs).toISOString(),
      age_ms: ageMs,
    });
  });

  router.post('/access', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.url !== 'string') return c.json({ error: 'url required' }, 400);
    if (!/^https?:\/\//.test(body.url)) return c.json({ matched: false, ignored: true });

    const title = typeof body.title === 'string' ? body.title : null;

    // Always upsert into page_visits (rolling counter) and append a per-event
    // row to visit_events (used by the diary aggregator for hourly buckets).
    upsertVisit(db, { url: body.url, title });
    insertVisitEvent(db, { url: body.url, title });
    // Lazily classify the domain in the background (skip for localhost, dedup
    // via domain_catalog rows).
    maybeQueueDomain(body.url);

    // If this URL is already bookmarked, also bump its bookmark access counter.
    const b = findBookmarkByUrl(db, body.url);
    if (!b) return c.json({ matched: false });
    recordAccess(db, b.id);
    return c.json({ matched: true, id: b.id });
  });

  // ---- visit history (unsaved URLs) -------------------------------------

  router.get('/visits/unsaved', (c) => {
    const since = c.req.query('since');
    const items = listUnsavedVisits(db, { since });
    const domains = [...new Set(items.map(v => extractDomainFromUrl(v.url)).filter(Boolean))];
    const urls = items.map(v => v.url);
    const catalog = getDomainCatalogMap(db, domains);
    const pageMap = getPageMetadataMap(db, urls);

    // Lazy-fetch any URL that doesn't have metadata yet.
    for (const url of urls) {
      if (!pageMap.has(url)) maybeQueuePageMetadata(url);
    }

    return c.json({
      items: items.map(v => {
        const dom = extractDomainFromUrl(v.url);
        const cat = dom ? catalog.get(dom) : null;
        const pm = pageMap.get(v.url);
        return {
          ...v,
          domain: dom,
          catalog: cat ? {
            site_name: cat.site_name,
            description: cat.description,
            can_do: cat.can_do,
            kind: cat.kind,
            title: cat.title,
            status: cat.status,
          } : null,
          page: pm ? {
            status: pm.status,
            summary: pm.summary,
            kind: pm.kind,
            meta_description: pm.meta_description,
            og_description: pm.og_description,
            page_title: pm.title,
          } : (dom && shouldSkipDomain(dom)) ? { status: 'skipped' } : { status: 'pending' },
        };
      }),
    });
  });

  router.get('/visits/suggested', (c) => {
    const days = Number(c.req.query('days')) || 30;
    return c.json({ items: listSuggestedVisits(db, { sinceDays: days }) });
  });

  router.get('/visits/unsaved/count', (c) => {
    const row = db.prepare(`
      SELECT COUNT(*) AS n
      FROM page_visits v
      LEFT JOIN bookmarks b ON b.url = v.url
      WHERE b.id IS NULL
        AND date(v.last_seen_at, 'localtime') = date('now', 'localtime')
    `).get();
    return c.json({ count: row?.n ?? 0 });
  });

  router.delete('/visits', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.urls)) return c.json({ error: 'urls[] required' }, 400);
    for (const url of body.urls) deleteVisit(db, url);
    return c.json({ ok: true, removed: body.urls.length });
  });

  router.post('/visits/bookmark', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.urls)) return c.json({ error: 'urls[] required' }, 400);
    return c.json({ results: await bulkSaveUrls(body.urls) });
  });

  // bulkSaveUrls is shared with /api/dig/:id/save (in routes/dig.js). It uses
  // the same closures as enqueueSummary so we keep the implementation here
  // and just expose it via the deps factory; routes/dig.js gets it through
  // its own deps argument.
  async function bulkSaveUrls(urls) {
    const results = [];
    for (const url of urls) {
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
        results.push({ url, status: 'skipped', error: 'invalid url' });
        continue;
      }
      const existing = findBookmarkByUrl(db, url);
      if (existing) {
        deleteVisit(db, url);
        results.push({ url, status: 'duplicate', id: existing.id });
        continue;
      }
      try {
        const visit = db.prepare(`SELECT title FROM page_visits WHERE url = ?`).get(url);
        const fetched = await fetchPageHtml(url);
        const title = (visit?.title || fetched.title || url).slice(0, 500);

        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const safe = ts + '_' + Math.random().toString(36).slice(2, 8) + '.html';
        writeFileSync(join(HTML_DIR, safe), fetched.html, 'utf8');

        const id = insertBookmark(db, { url, title, htmlPath: safe });
        recordAccess(db, id);
        enqueueSummary(id);
        deleteVisit(db, url);
        results.push({ url, status: 'queued', id });
      } catch (e) {
        results.push({ url, status: 'error', error: e.message });
      }
    }
    return results;
  }

  // ---- export / import --------------------------------------------------

  router.post('/export', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : null;
    const includeHtml = body.includeHtml !== false; // default true
    const all = ids
      ? ids.map(id => getBookmark(db, id)).filter(Boolean)
      : listBookmarks(db);
    const items = all.map(b => {
      const out = {
        url: b.url,
        title: b.title,
        summary: b.summary,
        memo: b.memo,
        categories: b.categories,
        created_at: b.created_at,
        last_accessed_at: b.last_accessed_at,
        access_count: b.access_count,
      };
      if (includeHtml) {
        try {
          out.html = readFileSync(join(HTML_DIR, b.html_path), 'utf8');
        } catch { out.html = null; }
      }
      return out;
    });
    return c.json({
      version: 1,
      exported_at: new Date().toISOString(),
      bookmarks: items,
    });
  });

  router.post('/import', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.bookmarks)) return c.json({ error: 'bookmarks[] required' }, 400);
    const results = { imported: 0, skipped: 0, ids: [] };
    for (const raw of body.bookmarks) {
      if (!raw?.url) continue;
      let htmlName = '';
      if (typeof raw.html === 'string' && raw.html.length > 0) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        htmlName = ts + '_' + Math.random().toString(36).slice(2, 8) + '.html';
        writeFileSync(join(HTML_DIR, htmlName), raw.html, 'utf8');
      }
      const r = insertImportedBookmark(db, { ...raw, html_path: htmlName });
      if (r.skipped) results.skipped++;
      else { results.imported++; results.ids.push(r.id); }
    }
    return c.json(results);
  });

  // ---- llm config -------------------------------------------------------

  router.get('/llm/config', (c) => {
    const cfg = getLlmConfig();
    const settings = getAppSettings(db);
    return c.json({
      config: {
        ...cfg,
        // Mask the API key when returning to FE.
        openai_api_key: cfg.openai_api_key ? '***' : '',
        openai_api_key_set: !!cfg.openai_api_key,
        // Standing memo passed to every diary generation.
        diary_global_memo: settings['diary.global_memo'] || '',
        user_profile: {
          age: settings['user.age'] ? Number(settings['user.age']) : null,
          sex: settings['user.sex'] || '',
          weight_kg: settings['user.weight_kg'] ? Number(settings['user.weight_kg']) : null,
          height_cm: settings['user.height_cm'] ? Number(settings['user.height_cm']) : null,
          activity_level: settings['user.activity_level'] || 'moderate',
        },
      },
      tasks: LLM_TASKS,
      providers: Object.entries(LLM_PROVIDERS).map(([key, v]) => ({
        key,
        label: v.label,
        kind: v.kind,
        supportsTools: v.supportsTools,
      })),
      runtime: {
        // Read-only — these are fixed for the process lifetime.
        port: PORT,
        data_dir: DATA_DIR,
        platform: process.platform,
      },
    });
  });

  router.patch('/llm/config', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const patch = settingsPatchFromConfig(body);
    // Don't blow away the API key with the masked '***' value.
    if (patch['llm.openai.api_key'] === '***') delete patch['llm.openai.api_key'];
    // Diary-specific standing memo lives outside the LLM config object.
    if (typeof body.diary_global_memo === 'string') {
      patch['diary.global_memo'] = body.diary_global_memo;
    }
    // ユーザプロファイル (適正カロリー計算用)
    if (body.user_profile && typeof body.user_profile === 'object') {
      const up = body.user_profile;
      if (up.age == null || (typeof up.age === 'number' && isFinite(up.age))) {
        patch['user.age'] = up.age == null ? '' : String(up.age);
      }
      if (typeof up.sex === 'string') {
        patch['user.sex'] = (up.sex === 'male' || up.sex === 'female') ? up.sex : '';
      }
      if (up.weight_kg == null || (typeof up.weight_kg === 'number' && isFinite(up.weight_kg))) {
        patch['user.weight_kg'] = up.weight_kg == null ? '' : String(up.weight_kg);
      }
      if (up.height_cm == null || (typeof up.height_cm === 'number' && isFinite(up.height_cm))) {
        patch['user.height_cm'] = up.height_cm == null ? '' : String(up.height_cm);
      }
      if (typeof up.activity_level === 'string' && Object.keys({sedentary:1, light:1, moderate:1, active:1, very_active:1}).includes(up.activity_level)) {
        patch['user.activity_level'] = up.activity_level;
      }
    }
    setAppSettings(db, patch);
    loadLlmConfigFromSettings(getAppSettings(db));
    return c.json({ ok: true });
  });

  // ---- Google Maps client config ---------------------------------------

  router.get('/maps/config', (c) => {
    const settings = getAppSettings(db);
    const key = settings['maps.api_key'] || process.env.GOOGLE_MAPS_API_KEY || '';
    return c.json({ apiKey: key, hasKey: !!key });
  });

  router.patch('/maps/config', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.apiKey !== 'string') {
      return c.json({ error: 'apiKey (string) required' }, 400);
    }
    setAppSettings(db, { 'maps.api_key': body.apiKey.trim() });
    return c.json({ ok: true });
  });

  // ---- domain catalog ---------------------------------------------------

  router.get('/domains', (c) => {
    const search = c.req.query('q')?.trim() || undefined;
    return c.json({ items: listDomainCatalogWithCounts(db, { search }) });
  });

  router.get('/domains/:domain', (c) => {
    const d = c.req.param('domain').toLowerCase();
    const row = getDomainCatalog(db, d);
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json(row);
  });

  router.patch('/domains/:domain', async (c) => {
    const d = c.req.param('domain').toLowerCase();
    const row = getDomainCatalog(db, d);
    if (!row) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    updateDomainCatalogUser(db, d, body);
    return c.json(getDomainCatalog(db, d));
  });

  router.post('/domains/:domain/regenerate', (c) => {
    const d = c.req.param('domain').toLowerCase();
    if (shouldSkipDomain(d)) return c.json({ error: 'skipped domain' }, 400);
    // Force re-classify even if a row exists; the user_edited flag still
    // protects manual fields.
    insertDomainPending(db, d);
    domainCatalogQueue.enqueue(async () => {
      const result = await classifyDomain({ domain: d });
      if (result.skip || result.dropRow) {
        deleteDomainCatalog(db, d);
        return;
      }
      if (!result.ok) {
        setDomainCatalog(db, d, { status: 'error', error: result.error });
        return;
      }
      setDomainCatalog(db, d, {
        title: result.title, site_name: result.site_name,
        description: result.description, can_do: result.can_do,
        kind: result.kind, status: 'done', error: null,
      });
    }, { kind: 'domain', domain: d, title: d });
    return c.json({ queued: true });
  });

  router.delete('/domains/:domain', (c) => {
    const d = c.req.param('domain').toLowerCase();
    deleteDomainCatalog(db, d);
    return c.json({ ok: true });
  });

  /**
   * page_visits + visit_events に蓄積されたアクセス記録の全ドメインを走査し、
   * domain_catalog にまだ無いものを fetch + 分類キューに積む。
   *
   * - 既存 catalog 行 (status=done/pending/error) は skip
   * - localhost / 127.0.0.1 等の skip 対象も skip
   * - body の `force=true` で既存行も強制的に再キュー (regenerate と同じ挙動を一括適用)
   *
   * 既存の lazy `maybeQueueDomain` (アクセス時に 1 件ずつ enqueue) を補完する
   * メンテナンス用 batch。「過去のアクセスのうち未分類のドメインを今すぐ全部分類」
   * という用途。
   */
  router.post('/domains/recatalog-all', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const force = body && body.force === true;

    // 2 ソースから unique URL を集める
    const visitedUrls = new Set();
    for (const r of db.prepare(`SELECT DISTINCT url FROM page_visits`).all()) {
      if (r.url) visitedUrls.add(r.url);
    }
    for (const r of db.prepare(`SELECT DISTINCT url FROM visit_events`).all()) {
      if (r.url) visitedUrls.add(r.url);
    }

    // URL → unique domain
    const seenDomains = new Map(); // domain -> sample url
    for (const url of visitedUrls) {
      const domain = extractDomainFromUrl(url);
      if (!domain) continue;
      if (!seenDomains.has(domain)) seenDomains.set(domain, url);
    }

    let queued = 0;
    let skippedExisting = 0;
    let skippedHost = 0;
    for (const [domain, sampleUrl] of seenDomains) {
      if (shouldSkipDomain(domain)) { skippedHost++; continue; }
      if (!force && getDomainCatalog(db, domain)) { skippedExisting++; continue; }
      if (force) {
        // regenerate と同じ流れ: pending 行を立てて、queue に積む
        insertDomainPending(db, domain);
        domainCatalogQueue.enqueue(async () => {
          const result = await classifyDomain({ domain });
          if (result.skip || result.dropRow) {
            deleteDomainCatalog(db, domain);
            return;
          }
          if (!result.ok) {
            setDomainCatalog(db, domain, { status: 'error', error: result.error });
            return;
          }
          setDomainCatalog(db, domain, {
            title: result.title, site_name: result.site_name,
            description: result.description, can_do: result.can_do,
            kind: result.kind, status: 'done', error: null,
          });
        }, { kind: 'domain', domain, title: domain });
      } else {
        // dedup 任せ (新ドメインだけが pending 行として入る)
        maybeQueueDomain(sampleUrl);
      }
      queued++;
    }

    return c.json({
      scanned_urls: visitedUrls.size,
      unique_domains: seenDomains.size,
      queued,
      skipped_existing: skippedExisting,
      skipped_host: skippedHost,
      queue_depth: domainCatalogQueue.depth,
      force,
    });
  });

  // ---- GPS locations (OwnTracks) ---------------------------------------
  //
  // 個人用の歩いた軌跡を記録する。MQTT subscriber (server/owntracks-server.js)
  // が別 process で挿入するのが本流だが、ここでも HTTP 直投入を許可する
  // (テスト + OwnTracks の HTTP モードからの直接 POST 用)。

  function getIngestKey() {
    const stored = (getAppSettings(db)['locations.ingest_key'] || '').trim();
    if (stored) return stored;
    return (process.env.LOCATIONS_INGEST_KEY ?? '').trim();
  }

  function decodeBasicAuth(headerVal) {
    if (!headerVal || !headerVal.startsWith('Basic ')) return null;
    try {
      const decoded = Buffer.from(headerVal.slice(6).trim(), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx < 0) return null;
      return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
    } catch {
      return null;
    }
  }

  function checkIngestKey(c) {
    const key = getIngestKey();
    if (!key) return null;
    // 1) custom header
    const xKey = c.req.header('x-memoria-ingest-key') ?? '';
    if (xKey && xKey === key) return null;
    // 2/3) Authorization
    const auth = c.req.header('authorization') ?? '';
    if (auth.startsWith('Bearer ')) {
      const tok = auth.slice(7).trim();
      if (tok === key) return null;
    }
    const basic = decodeBasicAuth(auth);
    if (basic && basic.pass === key) return null;
    return c.json({ error: 'invalid ingest key' }, 401, {
      'WWW-Authenticate': 'Basic realm="memoria-locations"',
    });
  }

  function maskKey(key) {
    if (!key) return '';
    if (key.length <= 8) return '*'.repeat(key.length);
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
  }

  router.get('/locations/settings', (c) => {
    const key = getIngestKey();
    return c.json({
      has_key: !!key,
      key_preview: maskKey(key),
      source: (getAppSettings(db)['locations.ingest_key'] || '').trim()
        ? 'settings'
        : (process.env.LOCATIONS_INGEST_KEY ? 'env' : 'none'),
    });
  });

  router.post('/locations/settings/regenerate', (c) => {
    const buf = new Uint8Array(20);
    const c2 = globalThis.crypto;
    c2.getRandomValues(buf);
    const newKey = [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
    setAppSettings(db, { 'locations.ingest_key': newKey });
    return c.json({ key: newKey, key_preview: maskKey(newKey) });
  });

  router.delete('/locations/settings/key', (c) => {
    setAppSettings(db, { 'locations.ingest_key': '' });
    return c.json({ ok: true });
  });

  /**
   * 直接 1 点の位置を投入する (OwnTracks HTTP モード or 手動テスト)。
   */
  router.post('/locations/ingest', async (c) => {
    const denied = checkIngestKey(c);
    if (denied) return denied;

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'json body required' }, 400);
    }
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return c.json({ error: 'lat / lon required (number)' }, 400);
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return c.json({ error: 'lat / lon out of range' }, 400);
    }

    const deviceId = body.device_id ?? body.tid ?? c.req.header('x-limit-d') ?? null;
    const tst = typeof body.tst === 'number' ? body.tst : undefined;
    const recordedAt = body.recorded_at ?? null;

    const rec = {
      userId: body.user_id ?? 'me',
      deviceId,
      tst,
      recordedAt,
      lat,
      lon,
      accuracy:  body.accuracy_m ?? body.acc ?? null,
      altitude:  body.altitude_m ?? body.alt ?? null,
      velocity:  body.velocity_kmh ?? body.vel ?? null,
      course:    body.course_deg ?? body.cog ?? null,
      battery:   body.battery_pct ?? body.batt ?? null,
      conn:      body.conn ?? null,
      rawJson:   JSON.stringify(body),
    };

    const result = insertGpsLocation(db, rec);
    if (!result.skipped) {
      // WebSocket subscriber に新規点をブロードキャスト
      broadcastLocation({
        id: result.id,
        user_id: rec.userId,
        device_id: rec.deviceId,
        recorded_at: rec.recordedAt
          ?? (typeof rec.tst === 'number' ? new Date(rec.tst * 1000).toISOString() : new Date().toISOString()),
        lat: rec.lat,
        lon: rec.lon,
        accuracy_m: rec.accuracy ?? null,
        altitude_m: rec.altitude ?? null,
        velocity_kmh: rec.velocity ?? null,
        course_deg: rec.course ?? null,
      });
    }
    c.header('X-Memoria-Insert-Id', String(result.id ?? ''));
    c.header('X-Memoria-Insert-Skipped', String(!!result.skipped));
    return c.json([]);
  });

  /**
   * 期間内の点を時系列順で返す。
   *   GET /api/locations?from=ISO&to=ISO&device=iphone
   *   GET /api/locations?date=YYYY-MM-DD              (local TZ)
   */
  router.get('/locations', (c) => {
    const url = new URL(c.req.url);
    const date = url.searchParams.get('date');
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return c.json({ error: 'date must be YYYY-MM-DD' }, 400);
      }
      const points = listGpsLocationsForDate(db, date);
      return c.json({ date, points });
    }
    const from = url.searchParams.get('from');
    const to   = url.searchParams.get('to');
    const deviceId = url.searchParams.get('device') ?? undefined;
    const points = listGpsLocationsInRange(db, { from, to, deviceId });
    return c.json({ from, to, deviceId: deviceId ?? null, points });
  });

  /** 位置情報を持っている日と件数。 UI の date picker 用。 */
  router.get('/locations/days', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 365) || 365, 3650);
    const days = listGpsLocationDays(db, { limit });
    return c.json({ days });
  });

  /** 古い位置情報を一括削除。 retention 用。 */
  router.delete('/locations', (c) => {
    const denied = checkIngestKey(c);
    if (denied) return denied;
    const olderThan = c.req.query('older_than');
    if (!olderThan) return c.json({ error: 'older_than (ISO) required' }, 400);
    const removed = deleteGpsLocationsOlderThan(db, olderThan);
    return c.json({ removed });
  });

  // bulkSaveUrls is exported via the returned object so routes/dig.js can
  // share the same implementation (avoiding two divergent copies).
  return { router, bulkSaveUrls };
}
