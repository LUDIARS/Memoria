import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb,
  insertBookmark,
  setSummary,
  listBookmarks,
  countBookmarks,
  getBookmark,
  listAllCategories,
  updateMemoAndCategories,
  deleteBookmark,
  recordAccess,
  findBookmarkByUrl,
  listAccesses,
  insertImportedBookmark,
  upsertVisit,
  listUnsavedVisits,
  listSuggestedVisits,
  deleteVisit,
  trendsCategories,
  trendsCategoryDiff,
  trendsTimeline,
  trendsDomains,
  trendsWorkHours,
  trendsKeywords,
  trendsGpsWalking,
} from './db.js';
import { summarizeWithClaude, htmlToText } from './claude.js';
import { FifoQueue, ConcurrentPool } from './queue.js';
import { recommendationsFor, dismissRecommendation, clearDismissals } from './recommendations.js';
import { runDig, runDigPreview, listSearchEngines, deriveDigTheme } from './dig.js';
import { runDigRawSerp } from './dig-serp.js';
import {
  insertDigSession, setDigResult, setDigPreview, setDigRawResults, getDigSession, listDigSessions, deleteDigSession,
  listDigThemes, digThemeContext,
  digSessionsForDate,
  insertWordCloud, setWordCloudResult, getWordCloud, listWordClouds,
  getBookmarkWordCloud, recentBookmarkWordClouds, trendsVisitDomains,
  listDictionaryEntries, getDictionaryEntry, findDictionaryEntryByTerm,
  insertDictionaryEntry, updateDictionaryEntry, deleteDictionaryEntry,
  addDictionaryLink, removeDictionaryLink,
  insertVisitEvent, getDiary, listDiariesInRange, upsertDiary, updateDiaryNotes,
  deleteDiary, getDiarySettings, setDiarySettings,
  getWeekly, listWeeklyForMonth, upsertWeekly, deleteWeekly,
  getDomainCatalog, listDomainCatalog, listDomainCatalogWithCounts, getDomainCatalogMap,
  insertDomainPending, setDomainCatalog, deleteDomainCatalog,
  updateDomainCatalogUser,
  getPageMetadata, getPageMetadataMap, insertPageMetadataPending,
  setPageMetadata, deletePageMetadata,
} from './db.js';
import { classifyDomain, shouldSkipDomain } from './domain-catalog.js';
import { fetchPageMetadata } from './page-metadata.js';
import { extractWordCloud, validateWordRelevance } from './wordcloud.js';
import { startUptimeTracking, readHeartbeat, DOWNTIME_THRESHOLD_MS } from './local/uptime.js';
import { listServerEvents, listServerEventsForDate } from './db.js';
import {
  aggregateDay, fetchGithubActivity, fetchGithubRange,
  generateDiary, generateWorkContent, generateHighlights,
  generateWeekly, summarizeGithubByRepo,
  bookmarksForDate,
  formatLocalDate, yesterdayLocal, weekRangeFor, weekOfMonth, pingGithub,
} from './diary.js';
import {
  TASKS as LLM_TASKS, PROVIDERS as LLM_PROVIDERS,
  getLlmConfig, loadLlmConfigFromSettings, settingsPatchFromConfig,
} from './llm.js';
import { getAppSettings, setAppSettings } from './db.js';
import {
  markBookmarkShared, markDigShared, markDictionaryShared,
  setBookmarkOwner, setDigOwner, setDictionaryOwner,
} from './db.js';
import {
  insertGpsLocation, listGpsLocationsInRange, listGpsLocationDays,
  listGpsLocationsForDate, deleteGpsLocationsOlderThan,
} from './db.js';
import { listPushSubscriptions, deletePushSubscription } from './db.js';
import {
  insertMeal, getMeal, listMeals, countMeals, updateMeal, deleteMeal, listPendingMeals,
} from './db.js';
import { initWebPush, getVapidPublicKey, saveSubscription, sendPushToAll } from './push.js';
import {
  extractPhotoMeta, resolveMealLocation, analyzeMealPhoto, getMealsApiKey,
} from './meals.js';
import {
  readMultiState, isConnected,
  readMultiServers, persistServers, upsertServer, removeServer,
  saveServerSession, clearServerSession, setActive, listConnectedActive,
  fetchMe, shareBookmark, shareDig, shareDictionary,
  multiFetch,
} from './local/multi-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MEMORIA_PORT ?? 5180);
const DATA_DIR = resolve(process.env.MEMORIA_DATA ?? join(__dirname, '..', 'data'));
const HTML_DIR = join(DATA_DIR, 'html');
const MEAL_DIR = join(DATA_DIR, 'meals');
const DB_PATH = join(DATA_DIR, 'memoria.db');
const CLAUDE_BIN = process.env.MEMORIA_CLAUDE_BIN ?? 'claude';

mkdirSync(HTML_DIR, { recursive: true });
mkdirSync(MEAL_DIR, { recursive: true });
const db = openDb(DB_PATH);
loadLlmConfigFromSettings(getAppSettings(db));
initWebPush(DATA_DIR);
const HEARTBEAT_FILE = join(DATA_DIR, 'heartbeat.json');
startUptimeTracking({ db, dataDir: DATA_DIR, heartbeatFile: HEARTBEAT_FILE });
const summaryQueue = new FifoQueue();
const cloudQueue = new FifoQueue();
const domainCatalogQueue = new FifoQueue();
const pageMetadataQueue = new FifoQueue();
const mealVisionQueue = new FifoQueue();

function maybeQueuePageMetadata(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); }
  catch { return; }
  if (shouldSkipDomain(host)) return;
  if (getPageMetadata(db, url)) return;
  insertPageMetadataPending(db, url);
  pageMetadataQueue.enqueue(async () => {
    const result = await fetchPageMetadata({ url });
    if (result.skip) {
      deletePageMetadata(db, url);
      return;
    }
    if (result.dropRow) {
      deletePageMetadata(db, url);
      console.log(`[page-meta] dropped ${url}: ${result.error}`);
      return;
    }
    if (!result.ok) {
      setPageMetadata(db, url, {
        title: result.title ?? null,
        meta_description: result.meta_description ?? null,
        og_title: result.og_title ?? null,
        og_description: result.og_description ?? null,
        og_image: result.og_image ?? null,
        og_type: result.og_type ?? null,
        content_type: result.content_type ?? null,
        http_status: result.http_status ?? null,
        status: 'error',
        error: result.error ?? 'unknown',
      });
      return;
    }
    setPageMetadata(db, url, {
      title: result.title,
      meta_description: result.meta_description,
      og_title: result.og_title,
      og_description: result.og_description,
      og_image: result.og_image,
      og_type: result.og_type,
      content_type: result.content_type,
      http_status: result.http_status,
      summary: result.summary,
      kind: result.kind,
      status: 'done',
      error: null,
    });
  }, { kind: 'page', url, title: url });
}

function extractDomainFromUrl(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
}

function maybeQueueDomain(url) {
  const domain = extractDomainFromUrl(url);
  if (!domain) return;
  if (shouldSkipDomain(domain)) return;
  // Cheap dedup: if we already have a row, skip. Pending rows count too.
  if (getDomainCatalog(db, domain)) return;
  insertDomainPending(db, domain);
  domainCatalogQueue.enqueue(async () => {
    const result = await classifyDomain({ domain });
    if (result.skip) {
      deleteDomainCatalog(db, domain);
      return;
    }
    if (result.dropRow) {
      // 404 / DNS error / non-2xx → drop the row entirely so it can be retried later.
      deleteDomainCatalog(db, domain);
      console.log(`[domain-catalog] dropped ${domain}: ${result.error}`);
      return;
    }
    if (!result.ok) {
      setDomainCatalog(db, domain, {
        title: result.title ?? null,
        description: result.metaDescription ?? null,
        status: 'error',
        error: result.error ?? 'unknown',
      });
      return;
    }
    setDomainCatalog(db, domain, {
      title: result.title,
      site_name: result.site_name,
      description: result.description,
      can_do: result.can_do,
      kind: result.kind,
      status: 'done',
      error: null,
    });
  }, { kind: 'domain', domain, title: domain });
}

// ブクマ AI 要約完了の push 通知は batch 化する。 個別通知は頻度過多
// (一度に 10〜30 件まとめて入れる運用) なので、 5 件 or 5 分でまとめて 1 回。
const bookmarkPushState = { items: /** @type {{id: number; title: string}[]} */ ([]), timer: /** @type {NodeJS.Timeout | null} */ (null) };
const BOOKMARK_PUSH_BATCH_SIZE = 5;
const BOOKMARK_PUSH_DEBOUNCE_MS = 5 * 60_000;

function flushBookmarkSummaryPush() {
  if (bookmarkPushState.items.length === 0) return;
  const items = bookmarkPushState.items;
  bookmarkPushState.items = [];
  if (bookmarkPushState.timer) {
    clearTimeout(bookmarkPushState.timer);
    bookmarkPushState.timer = null;
  }
  const titleLines = items.slice(0, 5).map((it) => `・${(it.title || '').slice(0, 60)}`).join('\n');
  const more = items.length > 5 ? `\n…他 ${items.length - 5} 件` : '';
  sendPushToAll(db, {
    title: `📚 AI 要約完了 (${items.length} 件)`,
    body: titleLines + more,
    url: '/?tab=bookmarks',
    tag: 'memoria-bookmark-summary',
  }).catch((err) => console.warn(`[push] bookmark batch failed: ${err.message}`));
}

function notifyBookmarkSummaryDone(id, title) {
  bookmarkPushState.items.push({ id, title: title || '(untitled)' });
  if (bookmarkPushState.items.length >= BOOKMARK_PUSH_BATCH_SIZE) {
    flushBookmarkSummaryPush();
    return;
  }
  if (!bookmarkPushState.timer) {
    bookmarkPushState.timer = setTimeout(flushBookmarkSummaryPush, BOOKMARK_PUSH_DEBOUNCE_MS);
  }
}

function enqueueSummary(id) {
  const b = getBookmark(db, id);
  summaryQueue.enqueue(async () => {
    const cur = getBookmark(db, id);
    if (!cur) throw new Error('bookmark not found');
    const htmlAbs = join(HTML_DIR, cur.html_path);
    if (!existsSync(htmlAbs)) {
      setSummary(db, id, { summary: null, categories: [], status: 'error', error: 'html file missing' });
      throw new Error('html file missing');
    }
    try {
      const html = readFileSync(htmlAbs, 'utf8');
      const { summary, categories } = await summarizeWithClaude({
        url: cur.url, title: cur.title, html,
      });
      setSummary(db, id, { summary, categories, status: 'done' });
      // batch 化された push 通知 (5 件 or 5 分)
      notifyBookmarkSummaryDone(id, cur.title);
    } catch (e) {
      setSummary(db, id, { summary: null, categories: [], status: 'error', error: e.message.slice(0, 500) });
      throw e;
    }
  }, {
    kind: 'summary',
    bookmarkId: id,
    title: b?.title ?? `id=${id}`,
    url: b?.url ?? '',
  });
}

// Recover any bookmarks left in 'pending' from a previous run.
{
  const pending = db.prepare(`SELECT id FROM bookmarks WHERE status = 'pending' ORDER BY created_at ASC`).all();
  if (pending.length > 0) {
    console.log(`[startup] re-queuing ${pending.length} pending summary job(s)`);
    for (const { id } of pending) enqueueSummary(id);
  }
}

const app = new Hono();
app.use('/api/*', cors({ origin: '*', allowMethods: ['GET','POST','PATCH','DELETE','OPTIONS'] }));

// 構造化 access ログ
app.use('*', async (c, next) => {
  const t0 = Date.now();
  let thrown;
  try { await next(); } catch (err) { thrown = err; throw err; }
  finally {
    const status = c.res?.status ?? (thrown ? 500 : 0);
    const entry = {
      ts: new Date().toISOString(),
      method: c.req.method, path: c.req.path,
      status, durationMs: Date.now() - t0,
    };
    if (thrown) entry.error = thrown instanceof Error ? thrown.message : String(thrown);
    const tag = status >= 500 ? '[http-error]' : status >= 400 ? '[http-warn]' : '[http]';
    console.log(`${tag} ${JSON.stringify(entry)}`);
  }
});

// ---- bookmark CRUD ---------------------------------------------------------

app.post('/api/bookmark', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.html !== 'string' || typeof body.url !== 'string') {
    return c.json({ error: 'html, url, title required' }, 400);
  }
  const url = body.url;
  const title = (body.title || url).slice(0, 500);
  const html = body.html;

  const existing = findBookmarkByUrl(db, url);
  if (existing) {
    // Same URL — record access and return existing.
    recordAccess(db, existing.id);
    return c.json({ id: existing.id, duplicate: true });
  }

  // Save HTML to disk first, then DB row, then kick off summarization.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = ts + '_' + Math.random().toString(36).slice(2, 8) + '.html';
  const htmlPath = join(HTML_DIR, safe);
  writeFileSync(htmlPath, html, 'utf8');

  const id = insertBookmark(db, { url, title, htmlPath: safe });

  // First access = creation.
  recordAccess(db, id);

  // Hand off to the FIFO queue so summarizations run strictly one at a time.
  enqueueSummary(id);

  return c.json({ id, queued: true, queueDepth: summaryQueue.depth });
});

app.get('/api/bookmarks', (c) => {
  // Pagination: bookmark count grew enough that returning every row + every
  // category lookup got noticeably slow. The UI now requests 50 at a time
  // (with `?q=` for server-side search) and asks for the next page on
  // demand. Internal callers (export / wordcloud / recommendations) skip
  // the limit and keep getting the full array.
  const category = c.req.query('category') || undefined;
  const sort = c.req.query('sort') || undefined;
  const q = c.req.query('q')?.trim() || undefined;
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50));
  const offset = Math.max(0, Number(c.req.query('offset')) || 0);
  const items = listBookmarks(db, { category, sort, q, limit, offset });
  const total = countBookmarks(db, { category, q });
  return c.json({ items, total, limit, offset });
});

app.get('/api/bookmarks/:id', (c) => {
  const id = Number(c.req.param('id'));
  const b = getBookmark(db, id);
  if (!b) return c.json({ error: 'not found' }, 404);
  const cloud = getBookmarkWordCloud(db, id);
  return c.json({ ...b, wordcloud: cloud });
});

app.patch('/api/bookmarks/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const b = getBookmark(db, id);
  if (!b) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  updateMemoAndCategories(db, id, {
    memo: typeof body.memo === 'string' ? body.memo : undefined,
    categories: Array.isArray(body.categories) ? body.categories : undefined,
  });
  return c.json(getBookmark(db, id));
});

app.delete('/api/bookmarks/:id', (c) => {
  const id = Number(c.req.param('id'));
  const htmlName = deleteBookmark(db, id);
  if (htmlName) {
    const p = join(HTML_DIR, htmlName);
    try { if (existsSync(p)) unlinkSync(p); } catch {}
  }
  return c.json({ ok: true });
});

app.post('/api/bookmarks/:id/resummarize', async (c) => {
  const id = Number(c.req.param('id'));
  const b = getBookmark(db, id);
  if (!b) return c.json({ error: 'not found' }, 404);
  const htmlPath = join(HTML_DIR, b.html_path);
  if (!existsSync(htmlPath)) return c.json({ error: 'html file missing' }, 404);

  // Keep the existing summary visible while regeneration runs.
  setSummary(db, id, { summary: b.summary, status: 'pending', error: null });

  enqueueSummary(id);

  return c.json({ ok: true, queued: true, queueDepth: summaryQueue.depth });
});

app.get('/api/bookmarks/:id/html', (c) => {
  const id = Number(c.req.param('id'));
  const b = getBookmark(db, id);
  if (!b) return c.text('not found', 404);
  const p = join(HTML_DIR, b.html_path);
  if (!existsSync(p)) return c.text('html missing', 404);
  return c.body(readFileSync(p), 200, { 'Content-Type': 'text/html; charset=utf-8' });
});

app.get('/api/bookmarks/:id/accesses', (c) => {
  const id = Number(c.req.param('id'));
  return c.json({ items: listAccesses(db, id) });
});

// ---- trends ---------------------------------------------------------------

app.get('/api/trends/categories', (c) => {
  const days = Number(c.req.query('days')) || 30;
  return c.json({ items: trendsCategories(db, { sinceDays: days }) });
});

app.get('/api/trends/category-diff', (c) => {
  const days = Number(c.req.query('days')) || 7;
  return c.json({ items: trendsCategoryDiff(db, { sinceDays: days }) });
});

app.get('/api/trends/timeline', (c) => {
  const days = Number(c.req.query('days')) || 30;
  return c.json({ items: trendsTimeline(db, { sinceDays: days }) });
});

app.get('/api/trends/domains', (c) => {
  const days = Number(c.req.query('days')) || 30;
  return c.json({ items: trendsDomains(db, { sinceDays: days }) });
});

app.get('/api/trends/visit-domains', (c) => {
  const days = Number(c.req.query('days')) || 30;
  return c.json({ items: trendsVisitDomains(db, { sinceDays: days }) });
});

app.get('/api/trends/work-hours', (c) => {
  const days = Number(c.req.query('days')) || 30;
  return c.json({ items: trendsWorkHours(db, { sinceDays: days }) });
});

app.get('/api/trends/keywords', (c) => {
  const days = Number(c.req.query('days')) || 30;
  return c.json({ items: trendsKeywords(db, { sinceDays: days, limit: 30 }) });
});

// GPS-derived walking trend (distance + walking-time + travel-time per day).
// Sourced from the OwnTracks ingestion pipeline. Days without points → 0s.
app.get('/api/trends/gps-walking', (c) => {
  const days = Number(c.req.query('days')) || 30;
  return c.json({ items: trendsGpsWalking(db, { sinceDays: days }) });
});

// GitHub commit trend (only meaningful when a token + user + repos are
// configured under diary settings). Cached in memory for 5 min so the user
// can flip the trends-range select without hammering the API.
const githubTrendCache = new Map(); // key = `${days}` → { at, payload }
app.get('/api/trends/github', async (c) => {
  const days = Number(c.req.query('days')) || 30;
  const key = `${days}`;
  const cached = githubTrendCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60_000) {
    return c.json(cached.payload);
  }
  const settings = settingsAsObject();
  if (!settings.github_user || !settings.github_repos?.length) {
    return c.json({ enabled: false, reason: 'github_not_configured' });
  }
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const until = new Date().toISOString();
  try {
    const r = await fetchGithubRange({
      token: settings.github_token,
      user: settings.github_user,
      repos: settings.github_repos,
      since, until,
    });
    // Per-day commit count for the line chart.
    const perDay = new Map();
    for (const c of (r.commits || [])) {
      const d = String(c.created_at || '').slice(0, 10);
      if (!d) continue;
      perDay.set(d, (perDay.get(d) || 0) + 1);
    }
    const today = new Date();
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const dt = new Date(today);
      dt.setDate(today.getDate() - i);
      const k = dt.toISOString().slice(0, 10);
      series.push({ date: k, count: perDay.get(k) || 0 });
    }
    const payload = {
      enabled: true,
      total: (r.commits || []).length,
      repos: r.repos || [],
      series,
    };
    githubTrendCache.set(key, { at: Date.now(), payload });
    return c.json(payload);
  } catch (e) {
    return c.json({ enabled: true, error: e.message, total: 0, repos: [], series: [] });
  }
});

// ---- recommendations ------------------------------------------------------

app.get('/api/recommendations', (c) => {
  const force = c.req.query('force') === '1';
  return c.json({ items: recommendationsFor(db, HTML_DIR, { force }) });
});

app.post('/api/recommendations/dismiss', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.url) return c.json({ error: 'url required' }, 400);
  dismissRecommendation(db, body.url);
  return c.json({ ok: true });
});

// ── WebPush API ────────────────────────────────────────────
//
// VAPID 鍵公開 (フロントの PushManager.subscribe 用) と、 端末ごとの
// subscription 登録 / 解除 / テスト送信。 シングルユーザ前提なので
// projectKey や userId は持たない。

app.get('/api/push/vapid-public-key', (c) => {
  const key = getVapidPublicKey();
  if (!key) return c.json({ error: 'VAPID not configured' }, 503);
  return c.json({ publicKey: key });
});

app.post('/api/push/subscribe', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
    return c.json({ error: 'subscription with keys.p256dh and keys.auth required' }, 400);
  }
  const id = saveSubscription(db, {
    endpoint: body.endpoint,
    p256dh: body.keys.p256dh,
    auth: body.keys.auth,
    label: body.label ?? null,
    userAgent: body.userAgent ?? c.req.header('user-agent') ?? null,
  });
  return c.json({ id, ok: true });
});

app.get('/api/push/subscriptions', (c) => {
  return c.json({ items: listPushSubscriptions(db) });
});

app.delete('/api/push/subscriptions/:id', (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
  const removed = deletePushSubscription(db, id);
  if (!removed) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

app.post('/api/push/test', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = await sendPushToAll(db, {
    title: body?.title ?? 'Memoria テスト通知',
    body: body?.body ?? '通知が届けば設定 OK です。',
    url: body?.url ?? '/',
    icon: '/icon-192.svg',
    tag: 'memoria-test',
  });
  return c.json(result);
});

app.delete('/api/recommendations/dismissals', (c) => {
  clearDismissals(db);
  return c.json({ ok: true });
});

// ---- meals (食事記録) -----------------------------------------------------
//
// 写真 + EXIF + GPS 軌跡から食事内容 / カロリー / 場所 / 時刻 を半自動で記録する。
//
// 解決順序:
//   - 食事時刻: EXIF DateTimeOriginal → 投稿時刻 (POST 受信時)
//   - 場所:     EXIF GPS → 既存 gps_locations ±5 分の最近点 → 手動 (PATCH)
//   - 内容/cal: OpenAI Vision (gpt-4o-mini) — API key 未設定なら pending のまま
//
// 解析失敗時 / API key 未設定時は ai_status='pending' のまま手動入力で運用可能。

const MEAL_PHOTO_MAX_BYTES = 12 * 1024 * 1024; // 12 MiB
const MEAL_VISION_TIMEOUT = 90_000;

function pickPhotoExt(filename, mime) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.png')) return '.png';
  if (lower.endsWith('.heic') || lower.endsWith('.heif')) return '.heic';
  if (lower.endsWith('.webp')) return '.webp';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/heic' || mime === 'image/heif') return '.heic';
  if (mime === 'image/webp') return '.webp';
  return '.jpg';
}

function mimeFromExt(p) {
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.heic') || p.endsWith('.heif')) return 'image/heic';
  if (p.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

function enqueueMealVision(id) {
  mealVisionQueue.enqueue(async () => {
    const meal = getMeal(db, id);
    if (!meal) return;
    const apiKey = getMealsApiKey(db);
    if (!apiKey) {
      updateMeal(db, id, {
        ai_status: 'pending',
        ai_error: 'OpenAI API key not configured (set llm.openai.api_key in settings)',
      });
      return;
    }
    const fullPath = join(MEAL_DIR, meal.photo_path);
    let buf;
    try {
      buf = readFileSync(fullPath);
    } catch (e) {
      updateMeal(db, id, { ai_status: 'error', ai_error: `read file: ${e.message}` });
      return;
    }
    const mime = mimeFromExt(meal.photo_path);
    try {
      const result = await Promise.race([
        analyzeMealPhoto(apiKey, buf.toString('base64'), mime),
        new Promise((_, reject) => setTimeout(() => reject(new Error('vision timeout')), MEAL_VISION_TIMEOUT)),
      ]);
      if (!result) {
        updateMeal(db, id, { ai_status: 'error', ai_error: 'vision returned null' });
        return;
      }
      updateMeal(db, id, {
        description: result.description ?? null,
        calories: typeof result.calories === 'number' ? result.calories : null,
        items_json: result.items ? JSON.stringify(result.items) : null,
        ai_status: 'done',
        ai_error: null,
      });
    } catch (e) {
      updateMeal(db, id, { ai_status: 'error', ai_error: String(e.message ?? e).slice(0, 500) });
    }
  }, { kind: 'meal-vision', meal_id: id, title: `meal #${id}` });
}

// POST /api/meals — multipart/form-data
//   photo:      File (required)
//   user_note:  string (optional)
//   eaten_at:   ISO8601 string (optional, 手動上書き)
//   lat / lon:  number (optional, 手動上書き)
app.post('/api/meals', async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'multipart/form-data required' }, 400);
  const photo = form.get('photo');
  if (!(photo instanceof File)) return c.json({ error: 'photo (File) required' }, 400);
  if (photo.size === 0) return c.json({ error: 'empty photo' }, 400);
  if (photo.size > MEAL_PHOTO_MAX_BYTES) {
    return c.json({ error: `photo too large (max ${MEAL_PHOTO_MAX_BYTES} bytes)` }, 413);
  }
  const buf = Buffer.from(await photo.arrayBuffer());
  const exif = await extractPhotoMeta(buf);

  const userNote = (form.get('user_note') || '').toString().trim() || null;
  const eatenAtRaw = (form.get('eaten_at') || '').toString().trim();
  const latRaw = (form.get('lat') || '').toString().trim();
  const lonRaw = (form.get('lon') || '').toString().trim();
  const manualLat = latRaw ? Number(latRaw) : null;
  const manualLon = lonRaw ? Number(lonRaw) : null;
  const hasManualLatLon =
    typeof manualLat === 'number' && isFinite(manualLat) &&
    typeof manualLon === 'number' && isFinite(manualLon);

  // 食事時刻: 手動 > EXIF > 投稿時刻
  let eatenAt = '';
  let eatenAtSource = 'manual';
  if (eatenAtRaw) {
    const d = new Date(eatenAtRaw);
    if (!isNaN(d.getTime())) {
      eatenAt = d.toISOString();
      eatenAtSource = 'manual';
    }
  }
  if (!eatenAt && exif.capturedAt) {
    eatenAt = exif.capturedAt;
    eatenAtSource = 'exif';
  }
  if (!eatenAt) {
    eatenAt = new Date().toISOString();
    eatenAtSource = 'post';
  }

  const loc = resolveMealLocation(
    db,
    exif,
    eatenAt,
    hasManualLatLon ? { lat: manualLat, lon: manualLon } : null,
  );

  const ext = pickPhotoExt(photo.name, photo.type);
  const id = insertMeal(db, {
    photo_path: 'placeholder' + ext,
    eaten_at: eatenAt,
    eaten_at_source: eatenAtSource,
    lat: loc.lat,
    lon: loc.lon,
    location_label: loc.label,
    location_source: loc.source,
    description: null,
    calories: null,
    items_json: null,
    ai_status: 'pending',
    ai_error: null,
    user_note: userNote,
  });

  const filename = `${id}${ext}`;
  const fullPath = join(MEAL_DIR, filename);
  try {
    writeFileSync(fullPath, buf);
  } catch (e) {
    deleteMeal(db, id);
    return c.json({ error: `write photo: ${e.message}` }, 500);
  }
  updateMeal(db, id, { photo_path: filename });

  enqueueMealVision(id);

  const created = getMeal(db, id);
  return c.json({ meal: created }, 201);
});

app.get('/api/meals', (c) => {
  const from = c.req.query('from') || undefined;
  const to = c.req.query('to') || undefined;
  const limit = Math.min(Number(c.req.query('limit') || 100), 500);
  const offset = Math.max(Number(c.req.query('offset') || 0), 0);
  const meals = listMeals(db, { from, to, limit, offset });
  const total = countMeals(db, { from, to });
  return c.json({ meals, total });
});

app.get('/api/meals/:id', (c) => {
  const id = Number(c.req.param('id'));
  const meal = getMeal(db, id);
  if (!meal) return c.json({ error: 'not found' }, 404);
  return c.json({ meal });
});

app.get('/api/meals/:id/photo', (c) => {
  const id = Number(c.req.param('id'));
  const meal = getMeal(db, id);
  if (!meal) return c.json({ error: 'not found' }, 404);
  const fullPath = join(MEAL_DIR, meal.photo_path);
  if (!existsSync(fullPath)) return c.json({ error: 'photo missing' }, 404);
  const buf = readFileSync(fullPath);
  return new Response(buf, {
    headers: {
      'Content-Type': mimeFromExt(meal.photo_path),
      'Cache-Control': 'private, max-age=86400',
    },
  });
});

app.patch('/api/meals/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const meal = getMeal(db, id);
  if (!meal) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'json body required' }, 400);

  const patch = {};
  if (typeof body.user_note === 'string') patch.user_note = body.user_note.trim() || null;
  if (typeof body.user_corrected_description === 'string') {
    patch.user_corrected_description = body.user_corrected_description.trim() || null;
  }
  if (body.user_corrected_calories === null) {
    patch.user_corrected_calories = null;
  } else if (typeof body.user_corrected_calories === 'number' && isFinite(body.user_corrected_calories)) {
    patch.user_corrected_calories = Math.round(body.user_corrected_calories);
  }
  if (typeof body.eaten_at === 'string' && body.eaten_at.trim()) {
    const d = new Date(body.eaten_at);
    if (!isNaN(d.getTime())) {
      patch.eaten_at = d.toISOString();
      patch.eaten_at_source = 'manual';
    }
  }
  if (body.lat === null && body.lon === null) {
    patch.lat = null;
    patch.lon = null;
    patch.location_source = 'none';
    patch.location_label = null;
  } else if (
    typeof body.lat === 'number' && isFinite(body.lat) &&
    typeof body.lon === 'number' && isFinite(body.lon)
  ) {
    patch.lat = body.lat;
    patch.lon = body.lon;
    patch.location_source = 'manual';
    patch.location_label = '手動指定';
  }

  if (Object.keys(patch).length > 0) updateMeal(db, id, patch);
  return c.json({ meal: getMeal(db, id) });
});

app.delete('/api/meals/:id', (c) => {
  const id = Number(c.req.param('id'));
  const meal = getMeal(db, id);
  if (!meal) return c.json({ error: 'not found' }, 404);
  try {
    const fullPath = join(MEAL_DIR, meal.photo_path);
    if (existsSync(fullPath)) unlinkSync(fullPath);
  } catch (e) {
    console.warn(`[meal#${id}] failed to delete photo: ${e.message}`);
  }
  deleteMeal(db, id);
  return c.json({ ok: true });
});

app.post('/api/meals/:id/reanalyze', (c) => {
  const id = Number(c.req.param('id'));
  const meal = getMeal(db, id);
  if (!meal) return c.json({ error: 'not found' }, 404);
  updateMeal(db, id, { ai_status: 'pending', ai_error: null });
  enqueueMealVision(id);
  return c.json({ meal: getMeal(db, id), queued: true });
});

// 起動時に pending 食事があれば解析を再投入 (前回終了時の中断分)
for (const m of listPendingMeals(db, { limit: 50 })) {
  enqueueMealVision(m.id);
}

// ---- dig (deep research) -------------------------------------------------
// All claude-using work (dig / cloud / diary / weekly / domain / page) runs
// strictly one job at a time so the user can watch progress in 作業リスト.
const digQueue = new FifoQueue();

function enqueueDig(id, query, { searchEngine = 'default', theme = null } = {}) {
  // Phase 0: raw SERP scrape — runs OUTSIDE the digQueue (no LLM, no
  // serialisation) so it lands within ~2 s regardless of whatever Claude
  // job is currently in flight. Failures are silent; the UI falls through
  // to the AI preview if this comes back empty.
  runDigRawSerp({ query, searchEngine })
    .then(raw => { if (raw) setDigRawResults(db, id, raw); })
    .catch(err => console.warn(`[dig#${id}] raw serp failed: ${err.message}`));

  digQueue.enqueue(async () => {
    // 同テーマの過去セッションから topics / sources / queries を集めて、
    // LLM プロンプトに 「これまで掘った領域」 として注入。 テーマ無しなら空。
    const themeCtx = theme ? digThemeContext(db, theme) : null;

    // Phase 1: SERP preview (fast — no page fetches). Persisted as soon as
    // it lands so the FE can render before the deep claude pass finishes.
    runDigPreview({ query, searchEngine })
      .then(preview => setDigPreview(db, id, preview))
      .catch(err => console.warn(`[dig#${id}] preview failed: ${err.message}`));
    // Phase 2: full deep analysis with WebFetch (existing behavior).
    try {
      const result = await runDig({ query, searchEngine, theme, themeContext: themeCtx });
      setDigResult(db, id, { status: 'done', result });
      // Dig 完了で push 通知 (登録済端末のみ)。 失敗は本体に影響させない。
      sendPushToAll(db, {
        title: `🔍 ディグ完了: ${query.slice(0, 40)}`,
        body: theme ? `テーマ: ${theme}` : 'AI 分析が出揃いました',
        url: `/?tab=dig&dig=${id}`,
        tag: `memoria-dig-${id}`,
      }).catch((err) => console.warn(`[push] dig#${id} notification failed: ${err.message}`));
    } catch (e) {
      setDigResult(db, id, { status: 'error', error: e.message.slice(0, 500) });
      throw e;
    }
  }, { kind: 'dig', sessionId: id, title: theme ? `[${theme}] ${query}` : query, search_engine: searchEngine });
}

app.post('/api/dig', async (c) => {
  const body = await c.req.json().catch(() => null);
  const query = body?.query;
  if (!query || typeof query !== 'string') return c.json({ error: 'query required' }, 400);
  const searchEngine = typeof body.search_engine === 'string' ? body.search_engine : 'default';
  // テーマ: フロントから明示指定があればそれを採用。 無ければ query から
  // 簡易抽出 (先頭の意味のあるフレーズ)。
  const theme = (typeof body.theme === 'string' && body.theme.trim())
    ? body.theme.trim().slice(0, 60)
    : deriveDigTheme(query);
  const id = insertDigSession(db, query, theme);
  enqueueDig(id, query, { searchEngine, theme });
  return c.json({ id, queued: true, theme, search_engine: searchEngine });
});

app.get('/api/dig/engines', (c) => {
  return c.json({ items: listSearchEngines() });
});

app.get('/api/dig/themes', (c) => {
  return c.json({ items: listDigThemes(db) });
});

app.get('/api/dig', (c) => {
  const theme = c.req.query('theme');
  return c.json({ items: listDigSessions(db, theme ? { theme } : {}) });
});

app.get('/api/dig/:id', (c) => {
  const id = Number(c.req.param('id'));
  const s = getDigSession(db, id);
  if (!s) return c.json({ error: 'not found' }, 404);
  return c.json(s);
});

// Delete a 誤 Dig. The row goes; downstream references (word_clouds
// origin_dig_id, dictionary_links source_kind='dig') become orphan and the
// existing UI handles missing sessions gracefully.
app.delete('/api/dig/:id', (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
  const removed = deleteDigSession(db, id);
  if (!removed) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true, id });
});

app.post('/api/dig/:id/save', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.urls)) return c.json({ error: 'urls[] required' }, 400);
  return c.json({ results: await bulkSaveUrls(body.urls) });
});

// ---- word clouds ---------------------------------------------------------

const BOOKMARK_DOC_LIMIT = 80;
const DIG_DOC_LIMIT = 30;
const SINGLE_BOOKMARK_TEXT_LIMIT = 12000;

function buildBookmarksDocs({ category, limit = BOOKMARK_DOC_LIMIT }) {
  const items = listBookmarks(db, { category }).slice(0, limit);
  return items.map((b, i) => {
    const cats = (b.categories || []).join(', ');
    const summary = (b.summary || '').slice(0, 800);
    return `[Doc ${i + 1}] ${b.title}\nURL: ${b.url}\nCategories: ${cats}\nSummary: ${summary}`;
  }).join('\n\n');
}

function buildDigDocs(session) {
  const r = session.result || {};
  const sources = (r.sources || []).slice(0, DIG_DOC_LIMIT);
  if (sources.length === 0) return '';
  const head = r.summary ? `OVERVIEW: ${r.summary}\n\n` : '';
  return head + sources.map((s, i) => {
    const topics = (s.topics || []).join(', ');
    return `[Doc ${i + 1}] ${s.title}\nURL: ${s.url}\nTopics: ${topics}\nSnippet: ${s.snippet}`;
  }).join('\n\n');
}

function buildBookmarkDoc(b) {
  let bodyText = '';
  try {
    const html = readFileSync(join(HTML_DIR, b.html_path), 'utf8');
    bodyText = htmlToText(html).slice(0, SINGLE_BOOKMARK_TEXT_LIMIT);
  } catch {}
  const cats = (b.categories || []).join(', ');
  return `Title: ${b.title}\nURL: ${b.url}\nCategories: ${cats}\nSummary: ${b.summary || ''}\n\nBody:\n${bodyText}`;
}

function enqueueCloud(id, { docs, label }) {
  cloudQueue.enqueue(async () => {
    try {
      const result = await extractWordCloud({ label, docs });
      setWordCloudResult(db, id, { status: 'done', result });
    } catch (e) {
      setWordCloudResult(db, id, { status: 'error', error: e.message.slice(0, 500) });
      throw e;
    }
  }, { kind: 'wordcloud', cloudId: id, title: label });
}

app.post('/api/wordcloud', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'body required' }, 400);
  const origin = body.origin;
  const parentCloudId = body.parentCloudId ?? null;
  const parentWord = typeof body.parentWord === 'string' ? body.parentWord : null;

  let label, docs, originDigId = null;

  if (origin === 'bookmarks') {
    const cat = body.category || null;
    const items = listBookmarks(db, { category: cat });
    if (items.length === 0) return c.json({ error: 'no bookmarks' }, 400);
    label = cat ? `bookmarks:${cat}` : 'all bookmarks';
    docs = buildBookmarksDocs({ category: cat });
  } else if (origin === 'dig') {
    const digId = Number(body.digId);
    const ses = getDigSession(db, digId);
    if (!ses) return c.json({ error: 'dig session not found' }, 404);
    if (ses.status !== 'done') return c.json({ error: `dig status: ${ses.status}` }, 400);
    label = ses.query;
    originDigId = digId;
    docs = buildDigDocs(ses);
    if (!docs) return c.json({ error: 'dig has no sources' }, 400);
  } else {
    return c.json({ error: 'origin must be bookmarks or dig' }, 400);
  }

  const id = insertWordCloud(db, { origin, originDigId, parentCloudId, parentWord, label });
  enqueueCloud(id, { docs, label });
  return c.json({ id, queued: true });
});

app.get('/api/wordcloud', (c) => {
  return c.json({ items: listWordClouds(db) });
});

app.get('/api/wordcloud/:id', (c) => {
  const id = Number(c.req.param('id'));
  const w = getWordCloud(db, id);
  if (!w) return c.json({ error: 'not found' }, 404);
  return c.json({ ...w, related_pages: buildRelatedPages(w) });
});

function buildRelatedPages(wc, depth = 0) {
  if (!wc || depth > 2) return [];
  if (wc.origin === 'dig' && wc.origin_dig_id) {
    const dig = getDigSession(db, wc.origin_dig_id);
    if (!dig) return [];
    const r = dig.result || {};
    return (r.sources || []).map(s => ({
      url: s.url, title: s.title || s.url,
      snippet: (s.snippet || '').slice(0, 200), kind: 'dig-source',
    }));
  }
  if (wc.origin === 'bookmark' && wc.origin_bookmark_id) {
    const b = getBookmark(db, wc.origin_bookmark_id);
    return b ? [{ url: b.url, title: b.title, snippet: (b.summary || '').slice(0, 200), kind: 'bookmark' }] : [];
  }
  if (wc.origin === 'bookmarks') {
    return listBookmarks(db).slice(0, 16).map(b => ({
      url: b.url, title: b.title, snippet: (b.summary || '').slice(0, 200), kind: 'bookmark',
    }));
  }
  if (wc.origin === 'merged') {
    const out = [];
    const seen = new Set();
    for (const m of (wc.result?.merged_from || [])) {
      const child = getWordCloud(db, m.id);
      for (const p of buildRelatedPages(child, depth + 1)) {
        if (seen.has(p.url)) continue;
        seen.add(p.url);
        out.push(p);
      }
    }
    return out.slice(0, 30);
  }
  return [];
}

app.get('/api/wordcloud/:id/graph', (c) => {
  const id = Number(c.req.param('id'));
  const radius = Math.min(3, Math.max(1, Number(c.req.query('radius')) || 3));
  if (!getWordCloud(db, id)) return c.json({ error: 'not found' }, 404);

  // BFS over parent_cloud_id (up) and child clouds (down).
  const seen = new Map(); // id → depth from current
  const queue = [{ id, depth: 0 }];
  seen.set(id, 0);
  while (queue.length > 0) {
    const { id: nid, depth } = queue.shift();
    if (depth >= radius) continue;
    const cur = db.prepare(`SELECT parent_cloud_id FROM word_clouds WHERE id = ?`).get(nid);
    if (cur?.parent_cloud_id && !seen.has(cur.parent_cloud_id)) {
      seen.set(cur.parent_cloud_id, depth + 1);
      queue.push({ id: cur.parent_cloud_id, depth: depth + 1 });
    }
    const children = db.prepare(`
      SELECT id FROM word_clouds WHERE parent_cloud_id = ? AND status = 'done'
    `).all(nid);
    for (const ch of children) {
      if (!seen.has(ch.id)) {
        seen.set(ch.id, depth + 1);
        queue.push({ id: ch.id, depth: depth + 1 });
      }
    }
  }

  // Count truncated branches (clouds at depth=radius that still have un-fetched
  // children — UI uses this to draw a "..." stub).
  const truncated = new Map(); // id → truncated_count
  for (const [nid, depth] of seen.entries()) {
    if (depth !== radius) continue;
    const childCount = db.prepare(`
      SELECT COUNT(*) AS n FROM word_clouds WHERE parent_cloud_id = ? AND status = 'done'
    `).get(nid)?.n ?? 0;
    if (childCount > 0) truncated.set(nid, childCount);
  }

  const nodes = [...seen.keys()].map(nid => {
    const wc = getWordCloud(db, nid);
    const r = wc?.result || {};
    const topWords = (r.words || []).filter(w => w.kept)
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
      .slice(0, 5)
      .map(w => ({ word: w.word, weight: w.weight }));
    const totalWeight = topWords.reduce((s, w) => s + (w.weight || 0), 0);
    return {
      id: nid,
      label: wc?.label || `cloud#${nid}`,
      parent_cloud_id: wc?.parent_cloud_id ?? null,
      parent_word: wc?.parent_word ?? null,
      origin: wc?.origin || '',
      depth: seen.get(nid),
      total_weight: totalWeight,
      top_words: topWords,
      summary: (r.summary || '').slice(0, 200),
      truncated_children: truncated.get(nid) ?? 0,
    };
  });
  const idsInGraph = new Set(seen.keys());
  const edges = nodes
    .filter(n => n.parent_cloud_id && idsInGraph.has(n.parent_cloud_id))
    .map(n => ({ from: n.parent_cloud_id, to: n.id, label: n.parent_word || '' }));

  return c.json({ current: id, radius, nodes, edges });
});

app.get('/api/wordcloud/:id/siblings', (c) => {
  const id = Number(c.req.param('id'));
  const cur = getWordCloud(db, id);
  if (!cur) return c.json({ error: 'not found' }, 404);
  if (!cur.parent_cloud_id) return c.json({ items: [] });
  const rows = db.prepare(`
    SELECT id, label, status, parent_word, created_at
    FROM word_clouds
    WHERE parent_cloud_id = ? AND id != ? AND status = 'done'
    ORDER BY id DESC
  `).all(cur.parent_cloud_id, id);
  return c.json({ items: rows });
});

app.post('/api/wordcloud/merge', async (c) => {
  const body = await c.req.json().catch(() => null);
  const cloudIds = Array.isArray(body?.cloudIds)
    ? body.cloudIds.map(Number).filter(Number.isFinite)
    : [];
  if (cloudIds.length < 2) return c.json({ error: 'cloudIds[] (>=2) required' }, 400);
  const clouds = cloudIds.map(id => getWordCloud(db, id)).filter(Boolean);
  const done = clouds.filter(c => c.status === 'done' && c.result);
  if (done.length < 2) return c.json({ error: 'need at least 2 completed clouds' }, 400);

  const merged = mergeWordCloudResults(done);
  const label = (typeof body?.label === 'string' && body.label.trim())
    ? body.label.trim().slice(0, 200)
    : `merged: ${done.map(d => d.label).join(' + ').slice(0, 160)}`;
  const id = insertWordCloud(db, {
    origin: 'merged',
    originDigId: null,
    parentCloudId: done[0].parent_cloud_id ?? null,
    parentWord: cloudIds.join(','),
    label,
  });
  setWordCloudResult(db, id, { status: 'done', result: merged });
  return c.json({ id });
});

function mergeWordCloudResults(clouds) {
  const map = new Map(); // word_lower → aggregate
  let firstSummary = '';
  for (const c of clouds) {
    const r = c.result || {};
    if (!firstSummary && r.summary) firstSummary = r.summary;
    for (const w of (r.words || [])) {
      const key = String(w.word || '').toLowerCase().trim();
      if (!key) continue;
      const cur = map.get(key) || {
        word: w.word, weightSum: 0, sources: 0, kept: false, count: 0, reasons: [],
      };
      cur.weightSum += Number(w.weight) || 0;
      cur.sources += Number(w.sources) || 1;
      cur.kept = cur.kept || !!w.kept;
      cur.count += 1;
      if (!w.kept && w.reason) cur.reasons.push(w.reason);
      map.set(key, cur);
    }
  }
  // Bonus: words appearing in more clouds get a boost.
  const words = [...map.values()].map(w => ({
    word: w.word,
    weight: Math.min(100, Math.round(w.weightSum + (w.count - 1) * 8)),
    sources: w.sources,
    kept: w.kept,
    reason: w.kept ? '' : (w.reasons[0] || ''),
  }));
  words.sort((a, b) => b.weight - a.weight);
  const labelList = clouds.map(c => `「${c.label}」`).join(' + ');
  return {
    summary: clouds.length === 2
      ? `${labelList} の合体クラウド (${words.length} 語)`
      : `${clouds.length} 件の関連クラウドを統合 (${words.length} 語)`,
    words: words.slice(0, 80),
    merged_from: clouds.map(c => ({ id: c.id, label: c.label })),
    base_summary: firstSummary,
  };
}

app.post('/api/wordcloud/validate-word', async (c) => {
  const body = await c.req.json().catch(() => null);
  const word = body?.word;
  const context = body?.context;
  if (!word || !context) return c.json({ error: 'word and context required' }, 400);
  try {
    const r = await validateWordRelevance({ word, context });
    return c.json(r);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Per-bookmark word cloud (default: not generated; on-demand).
app.post('/api/bookmarks/:id/wordcloud', async (c) => {
  const id = Number(c.req.param('id'));
  const b = getBookmark(db, id);
  if (!b) return c.json({ error: 'not found' }, 404);
  const docs = buildBookmarkDoc(b);
  const cloudId = insertWordCloud(db, {
    origin: 'bookmark',
    originDigId: null,
    parentCloudId: null,
    parentWord: null,
    label: b.title || b.url,
  });
  // Stamp origin_bookmark_id (insertWordCloud schema doesn't accept it directly).
  db.prepare(`UPDATE word_clouds SET origin_bookmark_id = ? WHERE id = ?`).run(id, cloudId);
  enqueueCloud(cloudId, { docs, label: b.title || b.url });
  return c.json({ id: cloudId, queued: true });
});

app.get('/api/bookmarks/:id/wordcloud', (c) => {
  const id = Number(c.req.param('id'));
  if (!getBookmark(db, id)) return c.json({ error: 'not found' }, 404);
  const cloud = getBookmarkWordCloud(db, id);
  return c.json({ cloud });
});

// ---- dictionary -----------------------------------------------------------

app.get('/api/dictionary', (c) => {
  const search = c.req.query('q')?.trim() || undefined;
  return c.json({ items: listDictionaryEntries(db, { search }) });
});

app.get('/api/dictionary/:id', (c) => {
  const id = Number(c.req.param('id'));
  const e = getDictionaryEntry(db, id);
  if (!e) return c.json({ error: 'not found' }, 404);
  return c.json(e);
});

app.post('/api/dictionary', async (c) => {
  const body = await c.req.json().catch(() => null);
  const term = (body?.term ?? '').toString().trim();
  if (!term) return c.json({ error: 'term required' }, 400);
  const existing = findDictionaryEntryByTerm(db, term);
  if (existing) {
    // Idempotent: update if any new fields supplied, otherwise return existing.
    const patch = {};
    if (typeof body.definition === 'string') patch.definition = body.definition;
    if (typeof body.notes === 'string') patch.notes = body.notes;
    if (Object.keys(patch).length > 0) updateDictionaryEntry(db, existing.id, patch);
    return c.json({ id: existing.id, existed: true });
  }
  const id = insertDictionaryEntry(db, {
    term,
    definition: body.definition ?? null,
    notes: body.notes ?? null,
  });
  return c.json({ id, existed: false });
});

app.patch('/api/dictionary/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!getDictionaryEntry(db, id)) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  updateDictionaryEntry(db, id, body);
  return c.json(getDictionaryEntry(db, id));
});

app.delete('/api/dictionary/:id', (c) => {
  const id = Number(c.req.param('id'));
  deleteDictionaryEntry(db, id);
  return c.json({ ok: true });
});

const VALID_DICT_SOURCE_KINDS = new Set(['cloud', 'dig', 'bookmark']);

app.post('/api/dictionary/:id/links', async (c) => {
  const id = Number(c.req.param('id'));
  if (!getDictionaryEntry(db, id)) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => null);
  const sourceKind = body?.source_kind;
  const sourceId = Number(body?.source_id);
  if (!VALID_DICT_SOURCE_KINDS.has(sourceKind)) return c.json({ error: 'source_kind must be cloud|dig|bookmark' }, 400);
  if (!Number.isFinite(sourceId)) return c.json({ error: 'source_id required' }, 400);
  addDictionaryLink(db, { entryId: id, sourceKind, sourceId });
  return c.json({ ok: true });
});

app.delete('/api/dictionary/:id/links', async (c) => {
  const id = Number(c.req.param('id'));
  const sourceKind = c.req.query('source_kind');
  const sourceId = Number(c.req.query('source_id'));
  if (!VALID_DICT_SOURCE_KINDS.has(sourceKind)) return c.json({ error: 'source_kind required' }, 400);
  if (!Number.isFinite(sourceId)) return c.json({ error: 'source_id required' }, 400);
  removeDictionaryLink(db, { entryId: id, sourceKind, sourceId });
  return c.json({ ok: true });
});

/** Convenience: upsert a term + add a source link in one call. */
app.post('/api/dictionary/upsert-from-source', async (c) => {
  const body = await c.req.json().catch(() => null);
  const term = (body?.term ?? '').toString().trim();
  const sourceKind = body?.source_kind;
  const sourceId = Number(body?.source_id);
  if (!term) return c.json({ error: 'term required' }, 400);
  if (!VALID_DICT_SOURCE_KINDS.has(sourceKind)) return c.json({ error: 'source_kind required' }, 400);
  if (!Number.isFinite(sourceId)) return c.json({ error: 'source_id required' }, 400);

  const existing = findDictionaryEntryByTerm(db, term);
  let entryId;
  let existed = false;
  if (existing) {
    entryId = existing.id;
    existed = true;
    if (typeof body.definition === 'string' || typeof body.notes === 'string') {
      updateDictionaryEntry(db, entryId, {
        definition: typeof body.definition === 'string' ? body.definition : undefined,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
      });
    }
  } else {
    entryId = insertDictionaryEntry(db, {
      term,
      definition: body.definition ?? null,
      notes: body.notes ?? null,
    });
  }
  addDictionaryLink(db, { entryId, sourceKind, sourceId });
  return c.json({ id: entryId, existed });
});

// ---- llm config -----------------------------------------------------------

app.get('/api/llm/config', (c) => {
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
    },
    tasks: LLM_TASKS,
    providers: Object.entries(LLM_PROVIDERS).map(([key, v]) => ({
      key,
      label: v.label,
      kind: v.kind,
      supportsTools: v.supportsTools,
    })),
    runtime: {
      // Read-only — these are fixed for the process lifetime. Exposing them
      // so the AI / Settings panel can show "Memoria is running on port X
      // with data at Y" without the user resorting to env vars.
      port: PORT,
      data_dir: DATA_DIR,
      platform: process.platform,
    },
  });
});

app.patch('/api/llm/config', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const patch = settingsPatchFromConfig(body);
  // Don't blow away the API key with the masked '***' value.
  if (patch['llm.openai.api_key'] === '***') delete patch['llm.openai.api_key'];
  // Diary-specific standing memo lives outside the LLM config object.
  if (typeof body.diary_global_memo === 'string') {
    patch['diary.global_memo'] = body.diary_global_memo;
  }
  setAppSettings(db, patch);
  loadLlmConfigFromSettings(getAppSettings(db));
  return c.json({ ok: true });
});

// ---- multi server (Memoria Hub) integration --------------------------------
//
// Phase 3: 📤 share button + connection management. The local server keeps a
// JWT in app_settings and forwards local resources through /api/shared/*.

app.get('/api/multi/status', (c) => {
  // Returns every registered server + which are active. The legacy
  // `connected/url/user` triple is kept on the response so existing
  // callers keep working: they reflect the FIRST active+connected one.
  const { servers, active } = readMultiServers(db);
  const list = servers.map(s => ({
    label: s.label, url: s.url,
    active: active.has(s.url),
    connected: !!(s.jwt && s.userId),
    user: s.userId ? { id: s.userId, name: s.userName, role: s.role } : null,
    connected_at: s.connectedAt,
  }));
  const primary = readMultiState(db);
  return c.json({
    servers: list,
    connected: isConnected(primary),
    url: primary.url,
    user: isConnected(primary) ? { id: primary.userId, name: primary.userName, role: primary.role } : null,
    connected_at: primary.connectedAt,
  });
});

app.post('/api/multi/servers', async (c) => {
  // Add or update a registered server entry (label + url). Doesn't
  // touch JWT — that's set by the OAuth /finish handler.
  const body = await c.req.json().catch(() => null);
  if (!body?.url) return c.json({ error: 'url required' }, 400);
  const { servers, active } = readMultiServers(db);
  const updated = upsertServer(servers, { label: body.label || body.url, url: body.url });
  persistServers(db, updated, active);
  return c.json({ ok: true });
});

app.delete('/api/multi/servers', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.url) return c.json({ error: 'url required' }, 400);
  const { servers, active } = readMultiServers(db);
  active.delete(String(body.url).replace(/\/$/, ''));
  persistServers(db, removeServer(servers, body.url), active);
  return c.json({ ok: true });
});

app.post('/api/multi/active', async (c) => {
  // Body: { urls: string[] } — replaces the active set.
  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body?.urls)) return c.json({ error: 'urls[] required' }, 400);
  setActive(db, body.urls);
  return c.json({ ok: true });
});

app.post('/api/multi/connect', async (c) => {
  // Kicks off the OAuth dance for a specific server URL. The URL is
  // registered (no-op if already there) and the SPA bounces through the
  // returned authorize URL.
  const body = await c.req.json().catch(() => null);
  if (!body?.url) return c.json({ error: 'url required' }, 400);
  const { servers, active } = readMultiServers(db);
  const updated = upsertServer(servers, { label: body.label || body.url, url: body.url });
  persistServers(db, updated, active);
  const redirectBack = body.redirect_uri || 'http://localhost:5180/?multi=connected';
  const start = `${body.url.replace(/\/$/, '')}/api/auth/start?redirect_uri=${encodeURIComponent(redirectBack)}`;
  return c.json({ ok: true, authorize_url: start });
});

app.post('/api/multi/finish', async (c) => {
  // SPA hands back the JWT after Cernere → Hub redirect. We need to know
  // WHICH server URL it belongs to. The SPA passes `url`; if missing we
  // fall back to the most-recently-touched registered server.
  const body = await c.req.json().catch(() => null);
  if (!body?.jwt) return c.json({ error: 'jwt required' }, 400);
  const { servers } = readMultiServers(db);
  const target = body.url
    ? servers.find(s => s.url === String(body.url).replace(/\/$/, ''))
    : servers[servers.length - 1];
  if (!target) return c.json({ error: 'no multi server registered' }, 400);
  let me;
  try { me = await fetchMe({ ...target, jwt: body.jwt }); }
  catch (e) { return c.json({ error: `verify failed: ${e.message}` }, 401); }
  saveServerSession(db, target.url, {
    jwt: body.jwt,
    userId: me.userId,
    userName: me.displayName,
    role: me.role,
  });
  return c.json({ ok: true, url: target.url, user: me });
});

app.post('/api/multi/disconnect', async (c) => {
  // Body: { url? } — disconnect a specific server, or all if omitted.
  const body = await c.req.json().catch(() => null);
  if (body?.url) {
    clearServerSession(db, body.url);
  } else {
    const { servers } = readMultiServers(db);
    for (const s of servers) clearServerSession(db, s.url);
  }
  return c.json({ ok: true });
});

// Proxy for the multi server. Forwards path + query through with the saved
// JWT so the SPA can call the Hub without dealing with CORS or a second
// login. GET / POST are both allowed; POST is restricted to the
// `/api/shared/moderation/*` endpoints since every other write should go
// through `/api/multi/share` (which also updates the local row).
async function proxyMulti(c, method) {
  const state = readMultiState(db);
  if (!isConnected(state)) return c.json({ error: 'not_connected' }, 400);
  const path = c.req.path.replace('/api/multi/proxy', '');
  if (method === 'POST' && !path.startsWith('/api/shared/moderation/')) {
    return c.json({ error: 'forbidden_proxy_write' }, 403);
  }
  const qs = new URL(c.req.url).search;
  const upstream = `${state.url.replace(/\/$/, '')}${path}${qs}`;
  const init = {
    method,
    headers: {
      'Authorization': `Bearer ${state.jwt}`,
      'Accept': 'application/json',
    },
  };
  if (method === 'POST') {
    init.headers['Content-Type'] = 'application/json';
    init.body = await c.req.text();
  }
  try {
    const res = await fetch(upstream, init);
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') || 'application/json',
      },
    });
  } catch (e) {
    return c.json({ error: `proxy failed: ${e.message}` }, 502);
  }
}
app.get('/api/multi/proxy/*', (c) => proxyMulti(c, 'GET'));
app.post('/api/multi/proxy/*', (c) => proxyMulti(c, 'POST'));

// Body: { kind: 'bookmark' | 'dig' | 'dict', id }
app.post('/api/multi/share', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.kind || body.id == null) return c.json({ error: 'kind+id required' }, 400);
  const state = readMultiState(db);
  if (!isConnected(state)) return c.json({ error: 'not_connected' }, 400);

  try {
    if (body.kind === 'bookmark') {
      const b = getBookmark(db, body.id);
      if (!b) return c.json({ error: 'not_found' }, 404);
      const r = await shareBookmark(state, b);
      markBookmarkShared(db, body.id, { sharedAt: r.shared_at, sharedOrigin: state.url });
      return c.json({ ok: true, remote: r });
    }
    if (body.kind === 'dig') {
      const d = getDigSession(db, body.id);
      if (!d) return c.json({ error: 'not_found' }, 404);
      const r = await shareDig(state, {
        query: d.query, status: d.status, result: d.result,
      });
      markDigShared(db, body.id, { sharedAt: r.shared_at, sharedOrigin: state.url });
      return c.json({ ok: true, remote: r });
    }
    if (body.kind === 'dict') {
      const e = getDictionaryEntry(db, body.id);
      if (!e) return c.json({ error: 'not_found' }, 404);
      const r = await shareDictionary(state, e);
      markDictionaryShared(db, body.id, { sharedAt: r.shared_at, sharedOrigin: state.url });
      return c.json({ ok: true, remote: r });
    }
    return c.json({ error: 'unknown kind' }, 400);
  } catch (e) {
    console.error('[multi/share]', e);
    return c.json({ error: e.message }, e.status || 500);
  }
});

// Body: { kind: 'bookmark' | 'dig' | 'dict', remote_id }
//
// Pulls a single resource from the connected Hub and writes it into the
// local SQLite. owner_user_id / owner_user_name are populated from the
// Hub row so the UI can render "by <user>" when the local owner is
// somebody else. shared_origin is set to the Hub URL.
app.post('/api/multi/download', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.kind || body.remote_id == null) return c.json({ error: 'kind+remote_id required' }, 400);
  const state = readMultiState(db);
  if (!isConnected(state)) return c.json({ error: 'not_connected' }, 400);

  try {
    if (body.kind === 'bookmark') {
      const remote = await multiFetch(state,`/api/shared/bookmarks/${body.remote_id}`);
      // Bookmarks need an HTML body locally — fetch the URL ourselves.
      // Fall back to a placeholder if the page is unreachable; the user
      // can re-fetch via the existing 再要約 button.
      const escapeHtml = (s = '') => String(s).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[ch]));
      let htmlBody;
      try { htmlBody = (await fetchPageHtml(remote.url)).html; }
      catch (e) {
        htmlBody = `<!-- downloaded from ${state.url}; original fetch failed: ${e.message} -->\n<html><head><title>${escapeHtml(remote.title || '')}</title></head><body></body></html>`;
      }
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const safe = ts + '_' + Math.random().toString(36).slice(2, 8) + '.html';
      writeFileSync(join(HTML_DIR, safe), htmlBody, 'utf8');
      const ins = insertImportedBookmark(db, {
        url: remote.url,
        title: remote.title,
        html_path: safe,
        summary: remote.summary,
        memo: remote.memo,
        categories: remote.categories || [],
      });
      if (ins.skipped) return c.json({ ok: true, duplicate: true, id: ins.id });
      setBookmarkOwner(db, ins.id, {
        ownerUserId: remote.owner_user_id,
        ownerUserName: remote.owner_user_name,
        sharedAt: remote.shared_at,
        sharedOrigin: state.url,
      });
      return c.json({ ok: true, id: ins.id });
    }
    if (body.kind === 'dig') {
      const remote = await multiFetch(state,`/api/shared/digs/${body.remote_id}`);
      const id = insertDigSession(db, remote.query);
      setDigResult(db, id, {
        status: remote.status || 'done',
        result: remote.result_json || remote.result || null,
        error: null,
      });
      setDigOwner(db, id, {
        ownerUserId: remote.owner_user_id,
        ownerUserName: remote.owner_user_name,
        sharedAt: remote.shared_at,
        sharedOrigin: state.url,
      });
      return c.json({ ok: true, id });
    }
    if (body.kind === 'dict') {
      const remote = await multiFetch(state,`/api/shared/dictionary/${body.remote_id}`);
      // Dictionary terms are unique locally — namespace remote-owned terms
      // with the owner so a download doesn't clobber a local entry.
      const namespacedTerm = remote.owner_user_id
        ? `${remote.term} (@${remote.owner_user_name || remote.owner_user_id})`
        : remote.term;
      const existing = findDictionaryEntryByTerm(db, namespacedTerm);
      let id;
      if (existing) {
        updateDictionaryEntry(db, existing.id, {
          definition: remote.definition,
          notes: remote.notes,
        });
        id = existing.id;
      } else {
        id = insertDictionaryEntry(db, {
          term: namespacedTerm,
          definition: remote.definition,
          notes: remote.notes,
        });
      }
      setDictionaryOwner(db, id, {
        ownerUserId: remote.owner_user_id,
        ownerUserName: remote.owner_user_name,
        sharedAt: remote.shared_at,
        sharedOrigin: state.url,
      });
      return c.json({ ok: true, id });
    }
    return c.json({ error: 'unknown kind' }, 400);
  } catch (e) {
    console.error('[multi/download]', e);
    return c.json({ error: e.message }, e.status || 500);
  }
});

// ---- server events / uptime -----------------------------------------------

app.get('/api/events', (c) => {
  const limit = Number(c.req.query('limit')) || 200;
  return c.json({ items: listServerEvents(db, { limit }) });
});

app.get('/api/uptime', (c) => {
  const hb = readHeartbeat(HEARTBEAT_FILE);
  return c.json({
    heartbeat: hb,
    downtime_threshold_ms: DOWNTIME_THRESHOLD_MS,
  });
});

// ---- queue status ---------------------------------------------------------

app.get('/api/queue', (c) => {
  return c.json({
    depth: summaryQueue.depth,
    running: summaryQueue.running,
  });
});

app.get('/api/queue/items', (c) => {
  return c.json({
    summary: summaryQueue.snapshot(),
    wordcloud: cloudQueue.snapshot(),
    dig: digQueue.snapshot(),
    diary: diaryQueue.snapshot(),
    weekly: weeklyQueue.snapshot(),
    domain: domainCatalogQueue.snapshot(),
    page: pageMetadataQueue.snapshot(),
    // Backward-compat top-level fields:
    ...summaryQueue.snapshot(),
  });
});

// ---- categories ------------------------------------------------------------

app.get('/api/categories', (c) => {
  return c.json({ items: listAllCategories(db) });
});

// ---- access ping (from extension) -----------------------------------------

// Lightweight status used by the SPA to badge whether the Chrome extension
// is actually feeding us /api/access pings. "Recent" = something landed in
// the last 24h; "active" = within the last 5 min (extension is running
// right now). The desktop app uses this to nudge first-run users to
// install the extension; a regular browser tab hides the badge entirely.
app.get('/api/extension/status', (c) => {
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

app.post('/api/access', async (c) => {
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

// ---- visit history (unsaved URLs) -----------------------------------------

app.get('/api/visits/unsaved', (c) => {
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

app.get('/api/domains', (c) => {
  const search = c.req.query('q')?.trim() || undefined;
  return c.json({ items: listDomainCatalogWithCounts(db, { search }) });
});

app.get('/api/domains/:domain', (c) => {
  const d = c.req.param('domain').toLowerCase();
  const row = getDomainCatalog(db, d);
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(row);
});

app.patch('/api/domains/:domain', async (c) => {
  const d = c.req.param('domain').toLowerCase();
  const row = getDomainCatalog(db, d);
  if (!row) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  updateDomainCatalogUser(db, d, body);
  return c.json(getDomainCatalog(db, d));
});

app.post('/api/domains/:domain/regenerate', (c) => {
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

app.delete('/api/domains/:domain', (c) => {
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
app.post('/api/domains/recatalog-all', async (c) => {
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

app.get('/api/visits/suggested', (c) => {
  const days = Number(c.req.query('days')) || 30;
  return c.json({ items: listSuggestedVisits(db, { sinceDays: days }) });
});

app.get('/api/visits/unsaved/count', (c) => {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM page_visits v
    LEFT JOIN bookmarks b ON b.url = v.url
    WHERE b.id IS NULL
      AND date(v.last_seen_at, 'localtime') = date('now', 'localtime')
  `).get();
  return c.json({ count: row?.n ?? 0 });
});

app.delete('/api/visits', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.urls)) return c.json({ error: 'urls[] required' }, 400);
  for (const url of body.urls) deleteVisit(db, url);
  return c.json({ ok: true, removed: body.urls.length });
});

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

app.post('/api/visits/bookmark', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.urls)) return c.json({ error: 'urls[] required' }, 400);
  return c.json({ results: await bulkSaveUrls(body.urls) });
});

async function fetchPageHtml(url, timeoutMs = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Memoria/0.2',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(ct)) {
      throw new Error(`unsupported content-type: ${ct}`);
    }
    const html = await res.text();
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = m ? decodeHtmlEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
    return { html, title };
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

// ---- export / import ------------------------------------------------------

app.post('/api/export', async (c) => {
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

app.post('/api/import', async (c) => {
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

// ---- diary ----------------------------------------------------------------

const diaryQueue = new FifoQueue();

function settingsAsObject() {
  const s = getDiarySettings(db);
  return {
    github_token: s.github_token || process.env.MEMORIA_GH_TOKEN || '',
    github_user: s.github_user || process.env.MEMORIA_GH_USER || '',
    github_repos: s.github_repos
      ? s.github_repos.split(',').map(x => x.trim()).filter(Boolean)
      : [],
  };
}

// Diary generation is split across several sub-stages so each one shows up
// in the queue UI as its own work item:
//   1. 📥 GitHub fetch (if configured) — diary_github
//   2. 📝 作業内容    (Sonnet)         — diary_work
//   3. ✨ ハイライト  (Opus 1M)         — diary_highlights
//
// Stages share a context object that is closed over by every queued task,
// so later stages can read what earlier stages produced. Failure in any
// stage marks the diary row as `error` and stops the chain.
function enqueueDiaryStages(dateStr, opts = {}) {
  const ctx = {
    metrics: null,
    github: null,
    notes: '',
    workContent: '',
    githubByRepo: null,
    highlights: '',
    bookmarkSummary: null,
    // One-shot improvement instruction from the UI (not persisted).
    improve: typeof opts.improve === 'string' ? opts.improve.trim() : '',
    // Standing memo from app_settings — passed to every prompt.
    globalMemo: '',
    failed: false,
  };

  function rememberFailure(stage, e) {
    ctx.failed = true;
    upsertDiary(db, {
      date: dateStr, status: 'error', metrics: ctx.metrics || aggregateDay(db, dateStr),
      githubCommits: ctx.github, error: `[${stage}] ${e.message}`.slice(0, 500),
    });
  }

  // Stage 0: snapshot metrics + reset diary row to pending. This is the
  // cheap first step but lives in the queue too so the user sees the
  // diary entering the pipeline immediately.
  diaryQueue.enqueue(async () => {
    if (ctx.failed) return;
    // Highlights/summary need the full bookmark+dig lists for accurate
    // counts and topDomains; the API response uses the default 10-per-list
    // limit so the SPA isn't asked to render hundreds of <li>s up front.
    ctx.metrics = aggregateDay(db, dateStr, { listLimit: null });
    const prior = getDiary(db, dateStr);
    ctx.notes = prior?.notes || '';
    ctx.globalMemo = (getAppSettings(db)['diary.global_memo'] || '').trim();
    upsertDiary(db, { date: dateStr, status: 'pending', metrics: ctx.metrics, error: null });
  }, { kind: 'diary_prepare', date: dateStr, title: `📅 ${dateStr} 集計` });

  // Stage 1: GitHub fetch (only if configured, otherwise no-op).
  diaryQueue.enqueue(async () => {
    if (ctx.failed) return;
    const settings = settingsAsObject();
    if (!settings.github_user) return;
    try {
      ctx.github = await fetchGithubActivity({
        token: settings.github_token,
        user: settings.github_user,
        repos: settings.github_repos,
        dateStr,
      });
    } catch (e) {
      rememberFailure('github', e);
      throw e;
    }
  }, { kind: 'diary_github', date: dateStr, title: `📥 ${dateStr} GitHub commits` });

  // Stage 2: 作業内容 (Sonnet by default). Sonnet also emits a tail
  // `WORK_MINUTES: <int>` line; generateWorkContent strips it from `content`
  // and returns it as `workMinutes` so we can persist it for the trends chart.
  diaryQueue.enqueue(async () => {
    if (ctx.failed) return;
    try {
      const work = await generateWorkContent({
        db, dateStr, metrics: ctx.metrics,
        globalMemo: ctx.globalMemo,
        improve: ctx.improve,
      });
      ctx.workContent = work.content;
      ctx.workMinutes = work.workMinutes;
      upsertDiary(db, {
        date: dateStr,
        workContent: ctx.workContent,
        workMinutes: ctx.workMinutes,
        metrics: ctx.metrics,
        githubCommits: ctx.github,
        status: 'pending',
        error: null,
      });
    } catch (e) {
      rememberFailure('work', e);
      throw e;
    }
  }, { kind: 'diary_work', date: dateStr, title: `📝 ${dateStr} 作業内容 (Sonnet)` });

  // Stage 3: ハイライト (Opus 1M by default) — depends on stage 2.
  diaryQueue.enqueue(async () => {
    if (ctx.failed) return;
    try {
      ctx.githubByRepo = summarizeGithubByRepo(ctx.github);
      const created = ctx.metrics?.bookmarks?.created || [];
      const accessed = ctx.metrics?.bookmarks?.accessed || [];
      const domSet = new Set();
      for (const b of [...created, ...accessed]) {
        try { domSet.add(new URL(b.url).hostname); } catch {}
      }
      ctx.bookmarkSummary = {
        created: created.length,
        accessed: accessed.length,
        topDomains: [...domSet].slice(0, 8),
      };
      const digs = ctx.metrics.digs || [];
      ctx.highlights = await generateHighlights({
        dateStr,
        workContent: ctx.workContent,
        githubByRepo: ctx.githubByRepo,
        bookmarkSummary: ctx.bookmarkSummary,
        digs, notes: ctx.notes, metrics: ctx.metrics,
        globalMemo: ctx.globalMemo,
        improve: ctx.improve,
      });
      const summary = composeDiarySummary({
        workContent: ctx.workContent,
        githubByRepo: ctx.githubByRepo,
        highlights: ctx.highlights,
        digs,
      });
      upsertDiary(db, {
        date: dateStr,
        summary,
        workContent: ctx.workContent,
        workMinutes: ctx.workMinutes,
        highlights: ctx.highlights,
        metrics: ctx.metrics,
        githubCommits: ctx.github,
        status: 'done',
        error: null,
      });
      // 日記が完成したら登録済端末に push 通知。 失敗しても本体には影響させない。
      sendPushToAll(db, {
        title: `📝 ${dateStr} の日記が完成しました`,
        body: ctx.highlights ? ctx.highlights.split('\n').slice(0, 2).join(' ').slice(0, 140) : '作業内容とハイライトが揃いました',
        url: `/?tab=diary&date=${encodeURIComponent(dateStr)}`,
        tag: `memoria-diary-${dateStr}`,
      }).catch((err) => {
        console.warn(`[push] diary notification failed: ${err.message}`);
      });
    } catch (e) {
      rememberFailure('highlights', e);
      throw e;
    }
  }, { kind: 'diary_highlights', date: dateStr, title: `✨ ${dateStr} ハイライト (Opus 1M)` });
}

// Mirror of `composeSummary` from diary.js — extracted here so we can run
// the highlights stage independently in the queue chain.
function composeDiarySummary({ workContent, githubByRepo, highlights, digs }) {
  const parts = [];
  if (workContent) parts.push(`## 作業内容\n${workContent.trim()}`);
  if (digs && digs.length > 0) {
    const digLines = digs.map(d => {
      const head = `- 「${d.query}」 (${d.source_count} 件のソース)`;
      return d.summary ? `${head}\n  ${d.summary.slice(0, 250)}` : head;
    }).join('\n');
    parts.push(`## ディグ調査\n${digLines}`);
  }
  if (githubByRepo?.repos?.length) {
    const repoLines = githubByRepo.repos.map(r => `- ${r.repo}: ${r.count} commits`).join('\n');
    parts.push(`## GitHub commits (${githubByRepo.total} 件)\n${repoLines}`);
  }
  if (highlights) parts.push(`## ハイライト\n${highlights.trim()}`);
  return parts.join('\n\n');
}

async function runDiaryGeneration(dateStr) {
  // Legacy single-step path kept for the weekly job, which orchestrates
  // its own run. The queued user-facing path goes through enqueueDiaryStages.
  const metrics = aggregateDay(db, dateStr);
  const settings = settingsAsObject();
  upsertDiary(db, { date: dateStr, status: 'pending', metrics, error: null });

  let github = null;
  if (settings.github_user) {
    github = await fetchGithubActivity({
      token: settings.github_token,
      user: settings.github_user,
      repos: settings.github_repos,
      dateStr,
    });
  }

  const prior = getDiary(db, dateStr);
  const notes = prior?.notes || '';

  let result;
  try {
    result = await generateDiary({
      db, dateStr, metrics, github, notes,
    });
  } catch (e) {
    upsertDiary(db, {
      date: dateStr, status: 'error', metrics,
      githubCommits: github, error: e.message.slice(0, 500),
    });
    throw e;
  }

  upsertDiary(db, {
    date: dateStr,
    summary: result.summary,
    workContent: result.workContent,
    workMinutes: result.workMinutes,
    highlights: result.highlights,
    metrics,
    githubCommits: github,
    status: 'done',
    error: null,
  });
}

function enqueueDiary(dateStr, opts = {}) {
  // User-facing diary regenerate. Splits into prepare → github → work →
  // highlights so each LLM/IO step is its own queue entry. The legacy
  // single-task path (runDiaryGeneration) is kept for the weekly cron.
  // `opts.improve` carries one-shot UI feedback for this run only.
  enqueueDiaryStages(dateStr, opts);
}

app.get('/api/diary', (c) => {
  // ?month=YYYY-MM (defaults to current local month)
  const monthQ = c.req.query('month');
  const today = new Date();
  const monthStr = (monthQ && /^\d{4}-\d{2}$/.test(monthQ))
    ? monthQ
    : `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const start = `${monthStr}-01`;
  const [y, m] = monthStr.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const end = `${monthStr}-${String(last).padStart(2, '0')}`;
  const items = listDiariesInRange(db, { start, end });
  return c.json({ month: monthStr, start, end, items });
});

app.get('/api/diary/:date', (c) => {
  const date = c.req.param('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
  const entry = getDiary(db, date) || { date, status: 'absent' };
  // The stored row contains both `metrics_json` (raw text) AND its parsed
  // `metrics` object. We also compute fresh `live_metrics`. Sending all
  // three triples the payload — for a busy day that pushed the response
  // past 1.8 MB and made the Tauri WebView freeze. Keep only live_metrics
  // (which is what the SPA actually reads) and drop the redundancies.
  const { metrics_json: _mj, metrics: _m, ...slim } = entry;
  // listLimit defaults to 10 — keeps the response small enough for the
  // Tauri WebView even on days with hundreds of bookmarks. Full lists
  // come from /api/diary/:date/bookmarks and /api/diary/:date/digs.
  const liveMetrics = aggregateDay(db, date);
  return c.json({ ...slim, live_metrics: liveMetrics });
});

// Paginated bookmark list for the diary panel's "more ▽" button.
//   ?kind=created|accessed&limit=20&offset=10
app.get('/api/diary/:date/bookmarks', (c) => {
  const date = c.req.param('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
  const kind = c.req.query('kind') === 'accessed' ? 'accessed' : 'created';
  const limit = Math.min(Number(c.req.query('limit')) || 20, 200);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const r = bookmarksForDate(db, date, { limit, offset });
  return c.json({
    items: r[kind],
    total: kind === 'accessed' ? r.accessed_total : r.created_total,
    offset, limit,
  });
});

// Paginated dig list for the diary panel.
app.get('/api/diary/:date/digs', (c) => {
  const date = c.req.param('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
  const limit = Math.min(Number(c.req.query('limit')) || 20, 200);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const all = digSessionsForDate(db, date);
  const slice = all.slice(offset, offset + limit).map(d => {
    const r = d.result || {};
    return {
      id: d.id, query: d.query, status: d.status, created_at: d.created_at,
      summary: (r.summary || '').slice(0, 600),
      source_count: (r.sources || []).length,
      sources: (r.sources || []).slice(0, 8).map(s => ({
        url: s.url, title: s.title, snippet: (s.snippet || '').slice(0, 200),
      })),
    };
  });
  return c.json({ items: slice, total: all.length, offset, limit });
});

app.post('/api/diary/:date/generate', async (c) => {
  const date = c.req.param('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
  // Body is optional. When present, `improve` is a one-shot instruction
  // appended to the prompt for this run only (not persisted).
  const body = await c.req.json().catch(() => null);
  enqueueDiary(date, { improve: body?.improve });
  return c.json({ queued: true, queue_depth: diaryQueue.depth });
});

app.patch('/api/diary/:date', async (c) => {
  const date = c.req.param('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.notes === 'string') {
    upsertDiary(db, { date, notes: body.notes });
  }
  return c.json(getDiary(db, date));
});

app.delete('/api/diary/:date', (c) => {
  const date = c.req.param('date');
  deleteDiary(db, date);
  return c.json({ ok: true });
});

app.get('/api/diary/settings', (c) => {
  // Mask the token when returning to the FE.
  const s = settingsAsObject();
  return c.json({
    github_user: s.github_user,
    github_repos: s.github_repos.join(','),
    github_token_set: !!s.github_token,
  });
});

app.post('/api/diary/settings', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const patch = {};
  if (typeof body.github_token === 'string') patch.github_token = body.github_token;
  if (typeof body.github_user === 'string') patch.github_user = body.github_user;
  if (typeof body.github_repos === 'string') patch.github_repos = body.github_repos;
  setDiarySettings(db, patch);
  return c.json({ ok: true });
});

/** Validate the saved GitHub PAT by hitting /user. */
app.post('/api/diary/test-github', async (c) => {
  const s = settingsAsObject();
  if (!s.github_token) return c.json({ ok: false, error: 'no token saved' });
  const r = await pingGithub({ token: s.github_token, user: s.github_user });
  return c.json(r);
});

// Midnight scheduler — fires at next 00:00:05 local, generates the previous
// day's diary, then re-schedules itself.
function scheduleMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  const ms = next.getTime() - now.getTime();
  setTimeout(async () => {
    try {
      const dateStr = yesterdayLocal();
      console.log(`[diary cron] generating ${dateStr}`);
      enqueueDiary(dateStr);
    } catch (e) {
      console.error('[diary cron] failed:', e.message);
    }
    scheduleMidnight();
  }, Math.max(60_000, ms)).unref?.();
}
scheduleMidnight();

// ---- weekly report --------------------------------------------------------

const weeklyQueue = new FifoQueue();

async function runWeeklyGeneration(weekStart) {
  const range = weekRangeFor(weekStart);
  const { weekInMonth, month } = weekOfMonth(range.start);
  upsertWeekly(db, {
    weekStart: range.start, weekEnd: range.end, month, weekInMonth,
    status: 'pending', error: null,
  });

  // Pull the 7 daily diaries (use whichever pieces are available).
  const dailyDiaries = listDiariesInRange(db, { start: range.start, end: range.end });

  // Pull commits across the week from configured repos.
  const settings = settingsAsObject();
  let githubByRepo = { repos: [], total: 0 };
  if (settings.github_user && settings.github_repos.length > 0) {
    const since = `${range.start}T00:00:00Z`;
    const until = `${range.end}T23:59:59Z`;
    const fetched = await fetchGithubRange({
      token: settings.github_token, user: settings.github_user,
      repos: settings.github_repos, since, until,
    });
    githubByRepo = summarizeGithubByRepo(fetched);
  }

  let summary;
  try {
    summary = await generateWeekly({
      weekStart: range.start, weekEnd: range.end,
      dailyDiaries, githubByRepo,
    });
  } catch (e) {
    upsertWeekly(db, {
      weekStart: range.start, status: 'error', githubSummary: githubByRepo,
      error: e.message.slice(0, 500),
    });
    throw e;
  }

  upsertWeekly(db, {
    weekStart: range.start, summary,
    githubSummary: githubByRepo,
    status: 'done', error: null,
  });
}

function enqueueWeekly(weekStart) {
  weeklyQueue.enqueue(async () => {
    await runWeeklyGeneration(weekStart);
  }, { kind: 'weekly', weekStart, title: weekStart });
}

app.get('/api/weekly', (c) => {
  const monthQ = c.req.query('month');
  const today = new Date();
  const monthStr = (monthQ && /^\d{4}-\d{2}$/.test(monthQ))
    ? monthQ
    : `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  return c.json({ month: monthStr, items: listWeeklyForMonth(db, monthStr) });
});

app.get('/api/weekly/:weekStart', (c) => {
  const ws = c.req.param('weekStart');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) return c.json({ error: 'invalid week_start' }, 400);
  const w = getWeekly(db, ws);
  if (!w) {
    const range = weekRangeFor(ws);
    const { weekInMonth, month } = weekOfMonth(range.start);
    return c.json({ week_start: range.start, week_end: range.end, month, week_in_month: weekInMonth, status: 'absent' });
  }
  return c.json(w);
});

app.post('/api/weekly/:weekStart/generate', (c) => {
  const ws = c.req.param('weekStart');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) return c.json({ error: 'invalid week_start' }, 400);
  const range = weekRangeFor(ws);
  enqueueWeekly(range.start);
  return c.json({ queued: true, week_start: range.start, week_end: range.end });
});

app.delete('/api/weekly/:weekStart', (c) => {
  const ws = c.req.param('weekStart');
  deleteWeekly(db, ws);
  return c.json({ ok: true });
});

// Sunday 23:00 cron — summarises Mon-Sun of the current week.
function scheduleSundayEvening() {
  const now = new Date();
  const next = new Date(now);
  const dow = now.getDay();
  const daysUntilSunday = dow === 0 ? 0 : (7 - dow); // 0=Sun,1=Mon,...6=Sat
  next.setDate(now.getDate() + daysUntilSunday);
  next.setHours(23, 0, 5, 0);
  if (next <= now) next.setDate(next.getDate() + 7);
  const ms = next.getTime() - now.getTime();
  setTimeout(async () => {
    try {
      // Today (Sunday) is the end of the week we're summarising.
      const today = new Date();
      const range = weekRangeFor(formatLocalDate(today));
      console.log(`[weekly cron] generating week ${range.start}`);
      enqueueWeekly(range.start);
    } catch (e) {
      console.error('[weekly cron] failed:', e.message);
    }
    scheduleSundayEvening();
  }, Math.max(60_000, ms)).unref?.();
}
scheduleSundayEvening();

// ---- PWA Web Share Target -------------------------------------------------
//
// PWA share_target (manifest.webmanifest) routes the OS share sheet here on
// Android. iOS has no PWA share_target — the iOS Shortcut template in
// docs/mobile-share.md drives this same endpoint instead.
//
// Inputs (all optional, supplied by the share sheet):
//   ?title=…  ?text=…  ?url=…
// We extract the first http(s) URL we can find, kick off a server-side fetch
// + summarize via the existing bulk-save path, then redirect back to the SPA.
function extractShareUrl(q) {
  const direct = (q.get('url') || '').trim();
  if (/^https?:\/\//i.test(direct)) return direct;
  for (const key of ['text', 'title']) {
    const v = (q.get(key) || '').trim();
    const m = v.match(/https?:\/\/\S+/i);
    if (m) return m[0].replace(/[.,;:!?)\]]+$/g, '');
  }
  return null;
}

app.get('/share', async (c) => {
  const q = new URL(c.req.url).searchParams;
  const target = extractShareUrl(q);
  if (!target) {
    return c.redirect('/?share=invalid', 303);
  }
  // Fire-and-forget — bulkSaveUrls handles dedup and queues the summary.
  bulkSaveUrls([target]).catch(err => {
    console.error('[share] bulkSaveUrls failed:', err.message);
  });
  return c.redirect('/?share=ok&u=' + encodeURIComponent(target), 303);
});

// ---- Google Maps client config -------------------------------------------
//
// API key は app_settings.`maps.api_key` か環境変数 GOOGLE_MAPS_API_KEY。
// ブラウザに渡す必要があるため masked 値ではなく実値を返す。
// Google Maps の鍵は HTTP referrer 制限 + API 制限を Google Cloud Console で
// かけて運用するのが筋。

app.get('/api/maps/config', (c) => {
  const settings = getAppSettings(db);
  const key = settings['maps.api_key'] || process.env.GOOGLE_MAPS_API_KEY || '';
  return c.json({ apiKey: key, hasKey: !!key });
});

app.patch('/api/maps/config', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.apiKey !== 'string') {
    return c.json({ error: 'apiKey (string) required' }, 400);
  }
  setAppSettings(db, { 'maps.api_key': body.apiKey.trim() });
  return c.json({ ok: true });
});

// ---- GPS locations (OwnTracks) -------------------------------------------
//
// 個人用の歩いた軌跡を記録する。MQTT subscriber (server/owntracks-server.js)
// が別 process で挿入するのが本流だが、ここでも HTTP 直投入を許可する
// (テスト + OwnTracks の HTTP モードからの直接 POST 用)。
//
// MQTT 経路で動かすには docker-compose で mosquitto を起動して
// `npm run owntracks` を別シェルで走らせること。
//
// 認証経路は 3 通りで、 いずれか一致すれば OK:
//   1. `X-Memoria-Ingest-Key: <key>`         (curl 等カスタムヘッダ向け)
//   2. `Authorization: Bearer <key>`         (一般的な API client)
//   3. `Authorization: Basic base64(u:<key>)` (OwnTracks iOS HTTP モードはこれ)
//
// Key の解決順:
//   a. app_settings.`locations.ingest_key` (UI から生成 / 設定)
//   b. 環境変数 LOCATIONS_INGEST_KEY (CI / CLI 用)
//   c. どちらも空 → 認証無効 (LAN-only バインドが前提)
//
// WAN 公開する時は UI から key を生成する (推奨) か env を必ず設定すること。

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
  // OwnTracks iOS は 401 を見ると basic auth ダイアログを出さず再試行するので
  // realm 付きで返しておく (ログから "認証要求" が判別しやすくなる)。
  return c.json({ error: 'invalid ingest key' }, 401, {
    'WWW-Authenticate': 'Basic realm="memoria-locations"',
  });
}

// ---- ingest key 管理 (UI 経由) -------------------------------------------
//
// 個人ツールなので key 自体は端末/ブラウザ側で確認できる必要がある。
// GET 系は読みやすいよう preview (先頭 4 + 末尾 4) を返し、 full 値は
// 1 度きりの「生成直後」response でしか出さない (再表示はクリア + 再生成)。

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '*'.repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

app.get('/api/locations/settings', (c) => {
  const key = getIngestKey();
  return c.json({
    has_key: !!key,
    key_preview: maskKey(key),
    source: (getAppSettings(db)['locations.ingest_key'] || '').trim()
      ? 'settings'
      : (process.env.LOCATIONS_INGEST_KEY ? 'env' : 'none'),
  });
});

app.post('/api/locations/settings/regenerate', (c) => {
  // crypto.randomUUID() の方が読みやすいが Basic auth password にする都合で
  // 32-byte hex の方が typing しやすい (40 文字)。
  const buf = new Uint8Array(20);
  // Node 18+ の global crypto。 globalThis 経由で webcrypto も使える
  // ((globalThis.crypto ?? require('node:crypto').webcrypto)).getRandomValues(buf);
  const c2 = globalThis.crypto;
  c2.getRandomValues(buf);
  const newKey = [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
  setAppSettings(db, { 'locations.ingest_key': newKey });
  return c.json({ key: newKey, key_preview: maskKey(newKey) });
});

app.delete('/api/locations/settings/key', (c) => {
  setAppSettings(db, { 'locations.ingest_key': '' });
  return c.json({ ok: true });
});

/**
 * 直接 1 点の位置を投入する (OwnTracks HTTP モード or 手動テスト)。
 * 受け取れる形式:
 *   - OwnTracks 形式: { _type:'location', lat, lon, tst, acc?, alt?, vel?, cog?, batt?, conn? }
 *   - 簡易形式:       { lat, lon, recorded_at?, device_id?, accuracy_m?, ... }
 */
app.post('/api/locations/ingest', async (c) => {
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
  // OwnTracks の HTTP モードはレスポンスとして JSON 配列 (友達の cards 等) を
  // 期待するので空配列で返す。 手動テスト時は X-Memoria-Insert-* header で
  // 結果を確認できる。
  c.header('X-Memoria-Insert-Id', String(result.id ?? ''));
  c.header('X-Memoria-Insert-Skipped', String(!!result.skipped));
  return c.json([]);
});

/**
 * 期間内の点を時系列順で返す。
 *   GET /api/locations?from=ISO&to=ISO&device=iphone
 *   GET /api/locations?date=YYYY-MM-DD              (local TZ)
 */
app.get('/api/locations', (c) => {
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

/**
 * 位置情報を持っている日と件数。 UI の date picker 用。
 */
app.get('/api/locations/days', (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 365) || 365, 3650);
  const days = listGpsLocationDays(db, { limit });
  return c.json({ days });
});

/**
 * 古い位置情報を一括削除。 retention 用。
 *   DELETE /api/locations?older_than=ISO
 */
app.delete('/api/locations', (c) => {
  const denied = checkIngestKey(c);
  if (denied) return denied;
  const olderThan = c.req.query('older_than');
  if (!olderThan) return c.json({ error: 'older_than (ISO) required' }, 400);
  const removed = deleteGpsLocationsOlderThan(db, olderThan);
  return c.json({ removed });
});

// ---- static UI ------------------------------------------------------------

app.use('/*', serveStatic({ root: './public' }));
app.get('/', serveStatic({ path: './public/index.html' }));

// ---- HTTP server + WebSocket -------------------------------------------
//
// `@hono/node-server::serve` は内部で http.Server を作って listen するので、
// その server hook (戻り値) に対して `ws` ライブラリで WebSocketServer を
// attach すれば HTTP / WS を同 port で兼ねられる。
//
// Cloudflare Tunnel は WS upgrade を素通しできるので、 wss://.../ws/locations
// で外からも繋がる (read-only broadcast。 認証は今後 ingest key で gate 予定)。

/** @type {Set<import('ws').WebSocket>} */
const wsClients = new Set();

function broadcastLocation(point) {
  if (wsClients.size === 0) return;
  const msg = JSON.stringify({ type: 'location', point });
  for (const c of wsClients) {
    if (c.readyState === 1 /* OPEN */) {
      try { c.send(msg); } catch {}
    }
  }
}

const httpServer = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Memoria server listening on http://localhost:${info.port}`);
  console.log(`  data dir: ${DATA_DIR}`);
  console.log(`  claude bin: ${CLAUDE_BIN}`);
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/ws/locations')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
  // 接続直後の hello (UI 側で接続成立を確認しやすくする)
  try { ws.send(JSON.stringify({ type: 'hello', ts: Date.now() })); } catch {}
});

// keep-alive: 30s ごとに ping。 Cloudflare の idle timeout (100s 程度) を超えない。
setInterval(() => {
  for (const c of wsClients) {
    if (c.readyState === 1) {
      try { c.ping(); } catch {}
    }
  }
}, 30_000).unref?.();

// ---- in-process MQTT subscriber (任意) ----------------------------------
//
// MEMORIA_MQTT_URL が設定されていれば、 main server process 内で OwnTracks
// subscriber を立てる。 別 process の owntracks-server.js は legacy として
// 残るが、 in-process にすると WebSocket broadcaster (broadcastLocation) を
// 直接呼べるので UI も即時更新される。
//
// 構成例 (Cloudflare Tunnel + MQTT over WSS):
//   [iOS/Android OwnTracks (WSS mode)]
//      │ wss://memoria.example.com/mqtt
//      ▼
//   [Cloudflare Tunnel ingress: /mqtt → ws://localhost:9002]
//      │
//      ▼
//   [mosquitto (docker compose、 host port 9002 → container 9001)]
//      │
//      ▼
//   [この process の subscriber → insertGpsLocation + broadcastLocation]

if (process.env.MEMORIA_MQTT_URL) {
  try {
    const { loadOwntracksConfig } = await import('./owntracks/config.js');
    const { startOwntracksClient } = await import('./owntracks/client.js');
    const { locationToDbRecord } = await import('./owntracks/payload.js');
    const cfg = loadOwntracksConfig();
    console.log(`[mqtt] in-process subscriber starting (url=${cfg.mqtt.url}, topic=${cfg.mqtt.topic})`);
    startOwntracksClient(cfg, async (topic, loc, ctx) => {
      const rec = locationToDbRecord(topic, loc, {
        userId: cfg.userId,
        rawJson: ctx.rawJson,
      });
      const result = insertGpsLocation(db, rec);
      if (!result.skipped) {
        broadcastLocation({
          id: result.id,
          user_id: rec.userId,
          device_id: rec.deviceId,
          recorded_at: new Date(rec.tst * 1000).toISOString(),
          lat: rec.lat,
          lon: rec.lon,
          accuracy_m: rec.accuracy ?? null,
          altitude_m: rec.altitude ?? null,
          velocity_kmh: rec.velocity ?? null,
          course_deg: rec.course ?? null,
        });
        console.log(
          `[mqtt] insert id=${result.id} ${rec.deviceId ?? '?'} ` +
          `(${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)})`
        );
      }
    });
  } catch (e) {
    console.error(`[mqtt] in-process subscriber failed to start: ${e?.message ?? e}`);
  }
}
