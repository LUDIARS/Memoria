import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb,
  insertBookmark,
  setSummary,
  listBookmarks,
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
} from './db.js';
import { summarizeWithClaude, htmlToText } from './claude.js';
import { FifoQueue, ConcurrentPool } from './queue.js';
import { recommendationsFor, dismissRecommendation, clearDismissals } from './recommendations.js';
import { runDig, runDigPreview } from './dig.js';
import {
  insertDigSession, setDigResult, setDigPreview, getDigSession, listDigSessions,
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
import { startUptimeTracking, readHeartbeat, DOWNTIME_THRESHOLD_MS } from './uptime.js';
import { listServerEvents, listServerEventsForDate } from './db.js';
import {
  aggregateDay, fetchGithubActivity, fetchGithubRange,
  generateDiary, generateWeekly, summarizeGithubByRepo,
  formatLocalDate, yesterdayLocal, weekRangeFor, weekOfMonth, pingGithub,
} from './diary.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MEMORIA_PORT ?? 5180);
const DATA_DIR = resolve(process.env.MEMORIA_DATA ?? join(__dirname, '..', 'data'));
const HTML_DIR = join(DATA_DIR, 'html');
const DB_PATH = join(DATA_DIR, 'memoria.db');
const CLAUDE_BIN = process.env.MEMORIA_CLAUDE_BIN ?? 'claude';

mkdirSync(HTML_DIR, { recursive: true });
const db = openDb(DB_PATH);
const HEARTBEAT_FILE = join(DATA_DIR, 'heartbeat.json');
startUptimeTracking({ db, dataDir: DATA_DIR, heartbeatFile: HEARTBEAT_FILE });
const summaryQueue = new FifoQueue();
const cloudQueue = new FifoQueue();
const domainCatalogQueue = new FifoQueue();
const pageMetadataQueue = new FifoQueue();

function maybeQueuePageMetadata(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); }
  catch { return; }
  if (shouldSkipDomain(host)) return;
  if (getPageMetadata(db, url)) return;
  insertPageMetadataPending(db, url);
  pageMetadataQueue.enqueue(async () => {
    const result = await fetchPageMetadata({ url, claudeBin: CLAUDE_BIN });
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
    const result = await classifyDomain({ domain, claudeBin: CLAUDE_BIN });
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
        url: cur.url, title: cur.title, html, claudeBin: CLAUDE_BIN,
      });
      setSummary(db, id, { summary, categories, status: 'done' });
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
  const category = c.req.query('category') || undefined;
  const sort = c.req.query('sort') || undefined;
  return c.json({ items: listBookmarks(db, { category, sort }) });
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

app.delete('/api/recommendations/dismissals', (c) => {
  clearDismissals(db);
  return c.json({ ok: true });
});

// ---- dig (deep research) -------------------------------------------------
// All claude-using work (dig / cloud / diary / weekly / domain / page) runs
// strictly one job at a time so the user can watch progress in 作業リスト.
const digQueue = new FifoQueue();

function enqueueDig(id, query) {
  digQueue.enqueue(async () => {
    // Phase 1: SERP preview (fast — no page fetches). Persisted as soon as
    // it lands so the FE can render before the deep claude pass finishes.
    runDigPreview({ query, claudeBin: CLAUDE_BIN })
      .then(preview => setDigPreview(db, id, preview))
      .catch(err => console.warn(`[dig#${id}] preview failed: ${err.message}`));
    // Phase 2: full deep analysis with WebFetch (existing behavior).
    try {
      const result = await runDig({ query, claudeBin: CLAUDE_BIN });
      setDigResult(db, id, { status: 'done', result });
    } catch (e) {
      setDigResult(db, id, { status: 'error', error: e.message.slice(0, 500) });
      throw e;
    }
  }, { kind: 'dig', sessionId: id, title: query });
}

app.post('/api/dig', async (c) => {
  const body = await c.req.json().catch(() => null);
  const query = body?.query;
  if (!query || typeof query !== 'string') return c.json({ error: 'query required' }, 400);
  const id = insertDigSession(db, query);
  enqueueDig(id, query);
  return c.json({ id, queued: true });
});

app.get('/api/dig', (c) => {
  return c.json({ items: listDigSessions(db) });
});

app.get('/api/dig/:id', (c) => {
  const id = Number(c.req.param('id'));
  const s = getDigSession(db, id);
  if (!s) return c.json({ error: 'not found' }, 404);
  return c.json(s);
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
      const result = await extractWordCloud({ label, docs, claudeBin: CLAUDE_BIN });
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
    const r = await validateWordRelevance({ word, context, claudeBin: CLAUDE_BIN });
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
    const result = await classifyDomain({ domain: d, claudeBin: CLAUDE_BIN });
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

async function runDiaryGeneration(dateStr) {
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
      db, dateStr, metrics, github, notes, claudeBin: CLAUDE_BIN,
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
    highlights: result.highlights,
    metrics,
    githubCommits: github,
    status: 'done',
    error: null,
  });
}

function enqueueDiary(dateStr) {
  diaryQueue.enqueue(async () => {
    await runDiaryGeneration(dateStr);
  }, { kind: 'diary', date: dateStr, title: dateStr });
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
  // Always include live metrics so the UI can chart even before the claude
  // narrative finishes. (cheap; pure SQL aggregation)
  const liveMetrics = aggregateDay(db, date);
  return c.json({ ...entry, live_metrics: liveMetrics });
});

app.post('/api/diary/:date/generate', (c) => {
  const date = c.req.param('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
  enqueueDiary(date);
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
      dailyDiaries, githubByRepo, claudeBin: CLAUDE_BIN,
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

// ---- static UI ------------------------------------------------------------

app.use('/*', serveStatic({ root: './public' }));
app.get('/', serveStatic({ path: './public/index.html' }));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Memoria server listening on http://localhost:${info.port}`);
  console.log(`  data dir: ${DATA_DIR}`);
  console.log(`  claude bin: ${CLAUDE_BIN}`);
});
