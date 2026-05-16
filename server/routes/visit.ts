// /api/trends/* + /api/recommendations* + /api/access + /api/visits/* +
// /api/activity/* + /api/worklog/* + /api/extension/status + /api/categories +
// /api/external/stats
//
// 「ブラウザ訪問 + 集計」 系の router。
// Spec: spec/api/visit.md

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  upsertVisit, listUnsavedVisits, listSuggestedVisits, deleteVisit,
  trendsCategories, trendsCategoryDiff, trendsTimeline, trendsDomains,
  trendsVisitDomains, trendsWorkHours, trendsKeywords, trendsGpsWalking,
  insertVisitEvent, insertExternalVisitEvent,
  recordAccess, findBookmarkByUrl,
  listAllCategories,
  getDomainCatalogMap, getPageMetadataMap,
  getAppSettings, diaryRepos,
  recordActivityEvent, listActivityEvents, activityEventsPage,
  pageVisitsForDate, revisitedBookmarksForDate, browsingDomainStatsForDate,
  listServerEvents, listServerEventsForDate,
  getLatestRecommendationRun, getRecommendationRun, listRecommendationRuns,
} from '../db.js';
import { shouldSkipDomain } from '../domain-catalog.js';
import { featureEnabled } from '../lib/privacy.js';
import {
  runAiRecommendations, isAiRecommendationsAvailable, isRecommendationsRunning,
  cancelAiRecommendations,
  type RecResultItem, type RecAgentLogBundle,
} from '../recommendations-ai.js';
import { fetchGithubRange } from '../diary.js';
import { readHeartbeat, DOWNTIME_THRESHOLD_MS } from '../local/uptime.js';
import { bulkSaveUrls } from '../lib/bulk-save.js';
import type { BulkSaveDeps } from '../lib/bulk-save.js';

type Db = BetterSqlite3.Database;

export interface VisitRouterDeps {
  db: Db;
  htmlDir: string;
  heartbeatFile: string;
  maybeQueuePageMetadata: (url: string) => void;
  maybeQueueDomain: (url: string) => void;
  bulkSaveDeps: BulkSaveDeps;
}

function safeParseArray(s: string): unknown[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}
function safeParseObject(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

export function makeVisitRouter(deps: VisitRouterDeps): Hono {
  const { db, heartbeatFile, maybeQueuePageMetadata, maybeQueueDomain, bulkSaveDeps } = deps;
  const r = new Hono();

  // ---- trends ---------------------------------------------------------------

  r.get('/api/trends/categories', (c: Context) => {
    const days = Number(c.req.query('days')) || 30;
    return c.json({ items: trendsCategories(db, { sinceDays: days }) });
  });

  r.get('/api/trends/category-diff', (c: Context) => {
    const days = Number(c.req.query('days')) || 7;
    return c.json({ items: trendsCategoryDiff(db, { sinceDays: days }) });
  });

  r.get('/api/trends/timeline', (c: Context) => {
    const days = Number(c.req.query('days')) || 30;
    return c.json({ items: trendsTimeline(db, { sinceDays: days }) });
  });

  r.get('/api/trends/domains', (c: Context) => {
    const days = Number(c.req.query('days')) || 30;
    return c.json({ items: trendsDomains(db, { sinceDays: days }) });
  });

  r.get('/api/trends/visit-domains', (c: Context) => {
    const days = Number(c.req.query('days')) || 30;
    return c.json({ items: trendsVisitDomains(db, { sinceDays: days }) });
  });

  r.get('/api/trends/work-hours', (c: Context) => {
    const days = Number(c.req.query('days')) || 30;
    return c.json({ items: trendsWorkHours(db, { sinceDays: days }) });
  });

  r.get('/api/trends/keywords', (c: Context) => {
    const days = Number(c.req.query('days')) || 30;
    return c.json({ items: trendsKeywords(db, { sinceDays: days, limit: 30 }) });
  });

  // GPS-derived walking trend (distance + walking-time + travel-time per day).
  // Sourced from the OwnTracks ingestion pipeline. Days without points → 0s.
  r.get('/api/trends/gps-walking', (c: Context) => {
    const days = Number(c.req.query('days')) || 30;
    return c.json({ items: trendsGpsWalking(db, { sinceDays: days }) });
  });

  // GitHub commit trend (only meaningful when a token + user + repos are
  // configured under diary settings). Cached in memory for 5 min so the user
  // can flip the trends-range select without hammering the API.
  interface GithubTrendPayload {
    enabled: boolean;
    reason?: string;
    error?: string;
    total?: number;
    repos?: { repo: string; count: number }[];
    series?: { date: string; count: number }[];
  }
  const githubTrendCache = new Map<string, { at: number; payload: GithubTrendPayload }>();

  function settingsAsObject() {
    const s = getAppSettings(db);
    return {
      github_token: s['diary.github_token'] || process.env.MEMORIA_GH_TOKEN || '',
      github_user: s['diary.github_user'] || process.env.MEMORIA_GH_USER || '',
      // 集計対象リポは `📋 作業一覧` (repo_watch) から導出。
      github_repos: diaryRepos(db),
    };
  }

  r.get('/api/trends/github', async (c: Context) => {
    const days = Number(c.req.query('days')) || 30;
    const key = `${days}`;
    const cached = githubTrendCache.get(key);
    if (cached && Date.now() - cached.at < 5 * 60_000) {
      return c.json(cached.payload);
    }
    const settings = settingsAsObject();
    if (!settings.github_user || !settings.github_repos.length) {
      return c.json({ enabled: false, reason: 'github_not_configured' });
    }
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const until = new Date().toISOString();
    try {
      const r2 = await fetchGithubRange({
        token: settings.github_token,
        user: settings.github_user,
        repos: settings.github_repos,
        since, until,
      });
      // Per-day commit count for the line chart.
      const perDay = new Map<string, number>();
      const commits = (r2.commits ?? []) as { created_at?: string }[];
      for (const cm of commits) {
        const d = String(cm.created_at ?? '').slice(0, 10);
        if (!d) continue;
        perDay.set(d, (perDay.get(d) ?? 0) + 1);
      }
      const today = new Date();
      const series: { date: string; count: number }[] = [];
      for (let i = days - 1; i >= 0; i--) {
        const dt = new Date(today);
        dt.setDate(today.getDate() - i);
        const k = dt.toISOString().slice(0, 10);
        series.push({ date: k, count: perDay.get(k) ?? 0 });
      }
      const payload: GithubTrendPayload = {
        enabled: true,
        total: commits.length,
        repos: r2.repos ?? [],
        series,
      };
      githubTrendCache.set(key, { at: Date.now(), payload });
      return c.json(payload);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ enabled: true, error: msg, total: 0, repos: [], series: [] });
    }
  });

  // ---- recommendations (AI 主導) -------------------------------------------
  //
  // 旧アルゴリズム版 (HTML リンク + 訪問ドメイン + word cloud) は廃止。
  // 6 領域 agent (Sonnet 並列) + 1 統合 (Opus) で 直近 1 週間のログを
  // 多角的に分析し、 「いま読むと打開につながる」 リソースを提示する。
  // AI が未設定の場合は available=false を返し、 UI 側でプレースホルダ表示。

  // 最新 done run + 進行中 run の状態を返す。 force=1 が来たら新規 run を蹴る。
  r.get('/api/recommendations', (c: Context) => {
    const avail = isAiRecommendationsAvailable();
    if (!avail.available) {
      return c.json({ available: false, reason: avail.reason, run: null });
    }
    const latest = getLatestRecommendationRun(db, 'done');
    const items = latest?.results_json ? safeParseArray(latest.results_json) as RecResultItem[] : [];
    return c.json({
      available: true,
      running: isRecommendationsRunning(db),
      run: latest ? {
        id: latest.id,
        started_at: latest.started_at,
        finished_at: latest.finished_at,
        result_count: latest.result_count,
        duration_ms: latest.duration_ms,
        model_sonnet: latest.model_sonnet,
        model_opus: latest.model_opus,
      } : null,
      items,
    });
  });

  r.post('/api/recommendations/run', async (c: Context) => {
    const avail = isAiRecommendationsAvailable();
    if (!avail.available) return c.json({ error: avail.reason }, 400);
    // body.force=true で既存のキューを cancel して新規実行を開始する。
    // (= キューが詰まって動かなくなった時に再実行で上書きするための逃げ道)
    let force = false;
    try {
      const body = await c.req.json().catch(() => null);
      force = !!(body && (body.force === true || body.force === 'true' || body.force === 1));
    } catch { /* 空 body は OK */ }
    if (!force && isRecommendationsRunning(db)) return c.json({ error: 'already_running' }, 409);
    // Fire-and-forget。 ユーザは status を polling する。
    void runAiRecommendations(db, { force }).catch(err => {
      console.error('[recommendations] run failed:', err instanceof Error ? err.message : err);
    });
    return c.json({ ok: true, started: true, forced: force });
  });

  // 詰まったキューを掃除する明示的なエンドポイント。
  // - in-memory inFlight ハンドルをクリア
  // - DB の 'running' 行を 'cancelled' に更新
  r.post('/api/recommendations/cancel', (c: Context) => {
    const r2 = cancelAiRecommendations(db, 'user_cancelled');
    return c.json({ ok: true, ...r2 });
  });

  r.get('/api/recommendations/runs', (c: Context) => {
    const limit = Number(c.req.query('limit')) || 30;
    return c.json({ items: listRecommendationRuns(db, limit) });
  });

  r.get('/api/recommendations/runs/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
    const run = getRecommendationRun(db, id);
    if (!run) return c.json({ error: 'not_found' }, 404);
    const items = run.results_json ? safeParseArray(run.results_json) as RecResultItem[] : [];
    const logs = run.agent_logs_json ? safeParseObject(run.agent_logs_json) as RecAgentLogBundle : null;
    return c.json({ run, items, logs });
  });

  // ---- categories ------------------------------------------------------------

  r.get('/api/categories', (c: Context) => {
    return c.json({ items: listAllCategories(db) });
  });

  // ---- access ping (from extension) -----------------------------------------

  // Lightweight status used by the SPA to badge whether the Chrome extension
  // is actually feeding us /api/access pings. "Recent" = something landed in
  // the last 24h; "active" = within the last 5 min (extension is running
  // right now). The desktop app uses this to nudge first-run users to
  // install the extension; a regular browser tab hides the badge entirely.
  r.get('/api/extension/status', (c: Context) => {
    const row = db.prepare(`
      SELECT visited_at FROM visit_events
      ORDER BY visited_at DESC
      LIMIT 1
    `).get() as { visited_at?: string } | undefined;
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

  r.post('/api/access', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as
      | { url?: unknown; title?: unknown }
      | null;
    if (!body || typeof body.url !== 'string') return c.json({ error: 'url required' }, 400);
    if (!/^https?:\/\//.test(body.url)) return c.json({ matched: false, ignored: true });

    const title = typeof body.title === 'string' ? body.title : null;

    // Always upsert into page_visits (rolling counter) and append a per-event
    // row to visit_events (used by the diary aggregator for hourly buckets).
    upsertVisit(db, { url: body.url, title });
    insertVisitEvent(db, { url: body.url, title });
    // Lazily classify the domain in the background (skip for localhost, dedup
    // via domain_catalog rows). `features.domain_catalog.auto_classify` で OFF にできる。
    if (featureEnabled(db, 'domain_catalog_auto_classify')) {
      maybeQueueDomain(body.url);
    }

    // If this URL is already bookmarked, also bump its bookmark access counter.
    const b = findBookmarkByUrl(db, body.url);
    if (!b) return c.json({ matched: false });
    recordAccess(db, b.id);
    return c.json({ matched: true, id: b.id });
  });

  // ---- visit history (unsaved URLs) -----------------------------------------

  r.get('/api/visits/unsaved', (c: Context) => {
    const since = c.req.query('since');
    const items = listUnsavedVisits(db, { since });
    const domains = [...new Set(items.map((v) => extractDomainFromUrl(v.url)).filter((d): d is string => !!d))];
    const urls = items.map((v) => v.url);
    const catalog = getDomainCatalogMap(db, domains);
    const pageMap = getPageMetadataMap(db, urls);

    // Lazy-fetch any URL that doesn't have metadata yet。
    // `features.page_metadata.auto_fetch` で OFF にできる (= 訪問は記録するが
    // LLM での kind 推論・要約は走らない)。
    if (featureEnabled(db, 'page_metadata_auto_fetch')) {
      for (const url of urls) {
        if (!pageMap.has(url)) maybeQueuePageMetadata(url);
      }
    }

    return c.json({
      items: items.map((v) => {
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

  r.get('/api/visits/suggested', (c: Context) => {
    const days = Number(c.req.query('days')) || 30;
    return c.json({ items: listSuggestedVisits(db, { sinceDays: days }) });
  });

  r.get('/api/visits/unsaved/count', (c: Context) => {
    const row = db.prepare(`
      SELECT COUNT(*) AS n
      FROM page_visits v
      LEFT JOIN bookmarks b ON b.url = v.url
      WHERE b.id IS NULL
        AND date(v.last_seen_at, 'localtime') = date('now', 'localtime')
    `).get() as { n?: number } | undefined;
    return c.json({ count: row?.n ?? 0 });
  });

  r.delete('/api/visits', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as { urls?: unknown } | null;
    if (!body || !Array.isArray(body.urls)) return c.json({ error: 'urls[] required' }, 400);
    for (const url of body.urls) {
      if (typeof url === 'string') deleteVisit(db, url);
    }
    return c.json({ ok: true, removed: body.urls.length });
  });

  r.post('/api/visits/bookmark', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as { urls?: unknown } | null;
    if (!body || !Array.isArray(body.urls)) return c.json({ error: 'urls[] required' }, 400);
    return c.json({ results: await bulkSaveUrls(bulkSaveDeps, body.urls) });
  });

  /**
   * 外部情報の取込状況をまとめて返す ("外部情報設定" タブ用)。
   * 位置情報 (gps_locations) と DNS/SNI tap (visit_events.source IN dns/sni) を
   * 1 endpoint で集約する。
   */
  r.get('/api/external/stats', (c: Context) => {
    // GPS
    const g24 = (db.prepare(`
      SELECT COUNT(*) AS n FROM gps_locations
      WHERE recorded_at >= datetime('now','-1 day')
    `).get() as { n?: number } | undefined)?.n ?? 0;
    const g7 = (db.prepare(`
      SELECT COUNT(*) AS n FROM gps_locations
      WHERE recorded_at >= datetime('now','-7 days')
    `).get() as { n?: number } | undefined)?.n ?? 0;
    const gDev = (db.prepare(`
      SELECT COUNT(DISTINCT device_id) AS n FROM gps_locations
      WHERE device_id IS NOT NULL AND recorded_at >= datetime('now','-7 days')
    `).get() as { n?: number } | undefined)?.n ?? 0;
    const gLatest = (db.prepare(`
      SELECT recorded_at FROM gps_locations ORDER BY recorded_at DESC LIMIT 1
    `).get() as { recorded_at?: string } | undefined)?.recorded_at ?? null;
    const gKey = (getAppSettings(db)['locations.ingest_key'] || '').trim();
    const gKeyConfigured = !!gKey || !!process.env.LOCATIONS_INGEST_KEY;

    // DNS/SNI
    const d24 = (db.prepare(`
      SELECT COUNT(*) AS n FROM visit_events
      WHERE source IN ('dns','sni') AND visited_at >= datetime('now','-1 day')
    `).get() as { n?: number } | undefined)?.n ?? 0;
    const d7 = (db.prepare(`
      SELECT COUNT(*) AS n FROM visit_events
      WHERE source IN ('dns','sni') AND visited_at >= datetime('now','-7 days')
    `).get() as { n?: number } | undefined)?.n ?? 0;
    const dDev = (db.prepare(`
      SELECT COUNT(DISTINCT device_label) AS n FROM visit_events
      WHERE source IN ('dns','sni') AND device_label IS NOT NULL
        AND visited_at >= datetime('now','-7 days')
    `).get() as { n?: number } | undefined)?.n ?? 0;
    const dLatest = (db.prepare(`
      SELECT visited_at FROM visit_events
      WHERE source IN ('dns','sni') ORDER BY visited_at DESC LIMIT 1
    `).get() as { visited_at?: string } | undefined)?.visited_at ?? null;
    const dRecent = db.prepare(`
      SELECT visited_at, domain, device_label, device_os, source FROM visit_events
      WHERE source IN ('dns','sni')
      ORDER BY visited_at DESC LIMIT 20
    `).all();

    return c.json({
      location: {
        configured: gKeyConfigured,
        active: g24 > 0,
        count_24h: g24,
        count_7d: g7,
        device_count: gDev,
        latest: gLatest,
      },
      dns: {
        // configured フラグは Legatus 側 env なので Memoria からは正確に分からない。
        // 直近にデータが届いているかで「実質 ON」 を判定する。
        configured: d7 > 0,
        active: d24 > 0,
        count_24h: d24,
        count_7d: d7,
        device_count: dDev,
        latest: dLatest,
        recent: dRecent,
      },
    });
  });

  /**
   * 外部 visit の取り込み状況サマリ。 「外部情報設定」 タブの status セクション用。
   * source IN ('dns', 'sni') を対象に件数 / device 数 / 最新時刻 / 直近 N 件を返す。
   */
  r.get('/api/visits/external/stats', (c: Context) => {
    const c24 = (db.prepare(`
      SELECT COUNT(*) AS n FROM visit_events
      WHERE source IN ('dns','sni') AND visited_at >= datetime('now','-1 day')
    `).get() as { n?: number } | undefined)?.n ?? 0;
    const c7 = (db.prepare(`
      SELECT COUNT(*) AS n FROM visit_events
      WHERE source IN ('dns','sni') AND visited_at >= datetime('now','-7 days')
    `).get() as { n?: number } | undefined)?.n ?? 0;
    const dev = (db.prepare(`
      SELECT COUNT(DISTINCT device_label) AS n FROM visit_events
      WHERE source IN ('dns','sni') AND device_label IS NOT NULL
        AND visited_at >= datetime('now','-7 days')
    `).get() as { n?: number } | undefined)?.n ?? 0;
    const latest = (db.prepare(`
      SELECT visited_at FROM visit_events
      WHERE source IN ('dns','sni')
      ORDER BY visited_at DESC LIMIT 1
    `).get() as { visited_at?: string } | undefined)?.visited_at ?? null;
    const recent = db.prepare(`
      SELECT visited_at, domain, device_label, device_os, source
      FROM visit_events
      WHERE source IN ('dns','sni')
      ORDER BY visited_at DESC LIMIT 20
    `).all();
    return c.json({ count_24h: c24, count_7d: c7, device_count: dev, latest, recent });
  });

  r.post('/api/visits/external', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as
      | { events?: unknown }
      | null;
    const events = Array.isArray(body?.events) ? body.events : null;
    if (!events) return c.json({ error: 'events[] required' }, 400);

    let inserted = 0;
    let skipped = 0;
    for (const ev of events as { domain?: unknown; source?: unknown; ts?: unknown; device_label?: unknown; device_os?: unknown }[]) {
      const domain = typeof ev?.domain === 'string' ? ev.domain.toLowerCase() : '';
      const source = ev?.source === 'sni' ? 'sni' : 'dns';
      if (!domain || !/^[a-z0-9.-]+$/.test(domain)) { skipped++; continue; }
      insertExternalVisitEvent(db, {
        domain,
        visitedAt: typeof ev.ts === 'string' ? ev.ts : null,
        source,
        deviceLabel: typeof ev.device_label === 'string' ? ev.device_label.slice(0, 200) : null,
        deviceOs: typeof ev.device_os === 'string' ? ev.device_os.slice(0, 50) : null,
      });
      // 既知の domain_catalog があれば description を埋める。 maybeQueueDomain
      // は内部で skipDomain (localhost / 内部 IP) を弾いてくれる。
      // `features.domain_catalog.auto_classify` で OFF にできる。
      if (featureEnabled(db, 'domain_catalog_auto_classify')) {
        maybeQueueDomain(`https://${domain}/`);
      }
      inserted++;
    }
    return c.json({ ok: true, inserted, skipped });
  });

  // ── activity events (git commit / claude code prompt 等) ─────────────────
  //
  // 外部のフック (グローバル git post-commit / Claude Code UserPromptSubmit hook
  // 等) からこのエンドポイントに POST してもらう。 同一 ref_id (commit sha 等) は
  // kind+ref_id の UNIQUE 制約で自動的に重複弾き。
  r.post('/api/activity/event', async (c: Context) => {
    let body: { kind?: unknown; occurred_at?: unknown; source?: unknown; ref_id?: unknown; content?: unknown; metadata?: unknown };
    try {
      body = await c.req.json() as typeof body;
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    const kind = String(body.kind ?? '');
    if (!kind) return c.json({ error: 'kind required' }, 400);
    const ALLOWED_KINDS = new Set(['git_commit', 'claude_code_prompt', 'gemini_prompt', 'codex_prompt']);
    if (!ALLOWED_KINDS.has(kind)) {
      return c.json({ error: `unknown kind: ${kind}` }, 400);
    }
    try {
      const result = recordActivityEvent(db, {
        kind: kind as 'git_commit' | 'claude_code_prompt' | 'gemini_prompt' | 'codex_prompt',
        occurred_at: typeof body.occurred_at === 'string' ? body.occurred_at : undefined,
        source: typeof body.source === 'string' ? body.source.slice(0, 500) : null,
        ref_id: typeof body.ref_id === 'string' ? body.ref_id.slice(0, 200) : null,
        content: typeof body.content === 'string' ? body.content.slice(0, 4000) : null,
        metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata as Record<string, unknown> : null,
      });
      return c.json({ ok: true, id: result.id, deduped: !result.inserted });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  // 当日の活動イベント (バーグラフ + ログ表示用、 ページング対応)。
  r.get('/api/activity/events', (c: Context) => {
    const date = c.req.query('date');
    const kindQ = c.req.query('kind');
    const allowedKinds = new Set<string>(['git_commit', 'claude_code_prompt', 'gemini_prompt', 'codex_prompt', 'task_created', 'task_done', 'task_updated']);
    type ActivityKindLocal = 'git_commit' | 'claude_code_prompt' | 'gemini_prompt' | 'codex_prompt' | 'task_created' | 'task_done' | 'task_updated';
    const kind: ActivityKindLocal | null = kindQ && allowedKinds.has(kindQ) ? kindQ as ActivityKindLocal : null;
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
      const limit = Number(c.req.query('limit')) || 100;
      const offset = Number(c.req.query('offset')) || 0;
      const page = activityEventsPage(db, date, { limit, offset, kind });
      return c.json({ date, kind, ...page });
    }
    const limit = Math.min(Number(c.req.query('limit')) || 200, 1000);
    return c.json({ items: listActivityEvents(db, { limit, kind }) });
  });

  // ── 作業ログ (worklog) 用 集計 -------------------------------------------
  r.get('/api/worklog/server-events', (c: Context) => {
    const date = c.req.query('date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ error: 'invalid date' }, 400);
    }
    return c.json({ date, items: listServerEventsForDate(db, date) });
  });

  r.get('/api/worklog/browsing', (c: Context) => {
    const date = c.req.query('date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ error: 'invalid date' }, 400);
    }
    const visitLimit = Math.min(Number(c.req.query('visit_limit')) || 200, 2000);
    const revisitLimit = Math.min(Number(c.req.query('revisit_limit')) || 100, 500);
    const domainLimit = Math.min(Number(c.req.query('domain_limit')) || 30, 200);

    const visits = pageVisitsForDate(db, date, { limit: visitLimit });
    const revisits = revisitedBookmarksForDate(db, date, { limit: revisitLimit });
    const stats = browsingDomainStatsForDate(db, date, { limit: domainLimit });

    // Enrich visits with domain catalog so the UI can show site_name / kind / status
    const visitDomains = [...new Set(visits.map((v) => extractDomainFromUrl(v.url)).filter((d): d is string => !!d))];
    const topDomainNames = (stats.top_domains ?? []).map((d: { domain: string }) => d.domain).filter(Boolean);
    const allDomains = [...new Set([...visitDomains, ...topDomainNames])];
    const catalog = getDomainCatalogMap(db, allDomains);
    const enrichedVisits = visits.map((v) => {
      const dom = extractDomainFromUrl(v.url);
      const cat = dom ? catalog.get(dom) : null;
      return {
        ...v,
        domain: dom,
        catalog: cat ? {
          site_name: cat.site_name, kind: cat.kind, description: cat.description,
          status: cat.status,
        } : null,
      };
    });
    const enrichedTopDomains = (stats.top_domains ?? []).map((d: { domain: string }) => ({
      ...d,
      catalog_status: catalog.get(d.domain)?.status ?? null,
    }));

    return c.json({
      date,
      visits: enrichedVisits,
      revisits,
      top_domains: enrichedTopDomains,
      total_pages: stats.total_pages,
      total_visits: stats.total_visits,
    });
  });

  // ---- server events / uptime -----------------------------------------------

  r.get('/api/events', (c: Context) => {
    const limit = Number(c.req.query('limit')) || 200;
    return c.json({ items: listServerEvents(db, { limit }) });
  });

  r.get('/api/uptime', (c: Context) => {
    const hb = readHeartbeat(heartbeatFile);
    return c.json({
      heartbeat: hb,
      downtime_threshold_ms: DOWNTIME_THRESHOLD_MS,
    });
  });

  return r;
}

function extractDomainFromUrl(u: string): string | null {
  try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
}
