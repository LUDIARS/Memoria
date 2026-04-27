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
import { FifoQueue } from './queue.js';
import { recommendationsFor, dismissRecommendation, clearDismissals } from './recommendations.js';
import { runDig } from './dig.js';
import { authMiddleware, readMode, MODES, requireAuth } from './auth.js';
import { checkContent } from './content-filter.js';
import { startCernere, stopCernere, emitEvent, isAdmissionRevoked } from './cernere.js';
import { embed, chunkText, cosine, vecToBuffer, bufferToVec, getModelName } from './embeddings.js';
import {
  deleteChunks, insertChunk, listChunkRows, bookmarksMissingEmbeddings, chunkStats,
  insertDigSession, setDigResult, getDigSession, listDigSessions,
} from './db.js';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MEMORIA_PORT ?? 5180);
const DATA_DIR = resolve(process.env.MEMORIA_DATA ?? join(__dirname, '..', 'data'));
const HTML_DIR = join(DATA_DIR, 'html');
const DB_PATH = join(DATA_DIR, 'memoria.db');
const CLAUDE_BIN = process.env.MEMORIA_CLAUDE_BIN ?? 'claude';
const RAG_ENABLED = process.env.MEMORIA_RAG !== '0';
const MODE = readMode();
const JWT_SECRET = process.env.MEMORIA_JWT_SECRET ?? '';
const ONLINE = MODE === MODES.ONLINE;
if (ONLINE && !JWT_SECRET) {
  console.error('[memoria] FATAL: MEMORIA_MODE=online requires MEMORIA_JWT_SECRET');
  process.exit(2);
}

mkdirSync(HTML_DIR, { recursive: true });
const db = openDb(DB_PATH);
const summaryQueue = new FifoQueue();
const embeddingQueue = new FifoQueue();
let chunkCache = null;
function invalidateChunkCache() { chunkCache = null; }
function loadChunkCache() {
  if (chunkCache) return chunkCache;
  const rows = listChunkRows(db);
  chunkCache = rows.map(r => ({
    id: r.id,
    bookmark_id: r.bookmark_id,
    idx: r.idx,
    text: r.text,
    vec: bufferToVec(r.vec),
  }));
  return chunkCache;
}

function enqueueEmbedding(id) {
  const meta = getBookmark(db, id);
  embeddingQueue.enqueue(async () => {
    const cur = getBookmark(db, id);
    if (!cur) throw new Error('bookmark not found');
    const htmlAbs = join(HTML_DIR, cur.html_path);
    if (!existsSync(htmlAbs)) throw new Error('html file missing');

    const html = readFileSync(htmlAbs, 'utf8');
    const text = htmlToText(html);
    const head = [cur.title, cur.summary].filter(Boolean).join('\n\n');
    const all = [];
    if (head) all.push(head);
    for (const c of chunkText(text)) all.push(c);
    if (all.length === 0) return;

    deleteChunks(db, id);
    const model = getModelName();
    let i = 0;
    for (const t of all) {
      const v = await embed(t, 'passage');
      insertChunk(db, { bookmarkId: id, idx: i++, text: t, vec: vecToBuffer(v), model });
    }
    invalidateChunkCache();
  }, {
    kind: 'embedding',
    bookmarkId: id,
    title: meta?.title ?? `id=${id}`,
    url: meta?.url ?? '',
  });
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
      // Schedule embedding generation in the background; if disabled or
      // not yet configured, embeddingQueue will simply error out per-job.
      if (RAG_ENABLED) enqueueEmbedding(id);
      // Notify subscribers (Imperativus etc.) — best-effort.
      emitEvent('memoria.summary.done', {
        userId: cur.user_id ?? null,
        payload: { id, url: cur.url, title: cur.title, summary, categories },
      });
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
app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));
app.use('/api/*', authMiddleware({ mode: MODE, secret: JWT_SECRET }));
// Cernere admission tracks revoked users; deny their service tokens even if
// the JWT signature still verifies.
app.use('/api/*', async (c, next) => {
  const uid = c.get('userId');
  if (uid && isAdmissionRevoked(uid)) {
    return c.json({ error: 'unauthorized: user revoked' }, 401);
  }
  return next();
});

// Block visit-history endpoints in online mode — that data is local-only.
const blockInOnline = (c, next) => {
  if (ONLINE) return c.json({ error: 'visits endpoints are disabled in online mode' }, 403);
  return next();
};

app.get('/api/mode', (c) => c.json({
  mode: MODE,
  rag_enabled: RAG_ENABLED,
  user_id: c.get('userId') ?? null,
  authenticated: !!c.get('userId'),
  // List of capabilities available to the current request — the FE uses this
  // to decide which write controls to render.
  caps: capabilitiesFor(c),
  // Hints the FE / extension can use to direct the user to the right
  // sign-in surface. None of these are required for Memoria itself; they
  // are pass-through configuration sourced from env.
  hints: {
    cernere_base_url: process.env.CERNERE_BASE_URL || process.env.CERNERE_URL || '',
    imperativus_url: process.env.MEMORIA_HINT_IMPERATIVUS_URL || '',
    issue_token_command: 'cd service && npm run issue-token <user_id>',
  },
}));

function capabilitiesFor(c) {
  if (MODE !== MODES.ONLINE) return ALL_CAPS;
  if (c.get('userId')) return ALL_CAPS;
  return READ_CAPS;
}

const ALL_CAPS = ['read', 'write', 'memo', 'import', 'export', 'dig', 'rag.ask'];
const READ_CAPS = ['read'];

// ---- bookmark CRUD ---------------------------------------------------------

/**
 * Core save logic shared by the local HTTP path and the Imperativus peer
 * relay path. Returns the same shape as `POST /api/bookmark` would.
 *
 * Throws a tagged error (`{ status, body }`) when the request should be
 * refused; callers translate it into either an HTTP response or a peer
 * exception.
 */
function saveBookmarkFromHtml({ url, title, html, userId }) {
  if (typeof html !== 'string' || typeof url !== 'string') {
    throw makeError(400, { error: 'html, url, title required' });
  }
  const titleStr = (title || url).slice(0, 500);

  const filt = checkContent({ url, title: titleStr, html });
  if (!filt.ok) {
    throw makeError(422, {
      error: 'content blocked by NG word filter',
      reason: filt.reason,
      matches: filt.matches,
    });
  }

  const existing = findBookmarkByUrl(db, url, { userId });
  if (existing) {
    recordAccess(db, existing.id);
    return { id: existing.id, duplicate: true };
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = ts + '_' + Math.random().toString(36).slice(2, 8) + '.html';
  writeFileSync(join(HTML_DIR, safe), html, 'utf8');

  const id = insertBookmark(db, { url, title: titleStr, htmlPath: safe, userId });
  recordAccess(db, id);
  enqueueSummary(id);

  emitEvent('memoria.bookmark.saved', {
    userId,
    payload: { id, url, title: titleStr },
  });

  return { id, queued: true, queueDepth: summaryQueue.depth };
}

function makeError(status, body) {
  const err = new Error(body.error || 'request rejected');
  err.status = status;
  err.body = body;
  return err;
}

app.post('/api/bookmark', async (c) => {
  // In ONLINE mode the only supported save path is via the Imperativus relay
  // (POST /api/relay/memoria/save_html → peer.invoke memoria.save_html).
  // Direct HTTP submissions from the Chrome extension are intentionally
  // rejected so all multi-user writes flow through the gateway.
  if (ONLINE) {
    return c.json({
      error: 'direct /api/bookmark is disabled in online mode — use POST /api/relay/memoria/save_html via Imperativus',
    }, 410);
  }
  const denied = requireAuth(c);
  if (denied) return denied;
  const userId = c.get('userId') ?? null;
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'json body required' }, 400);
  try {
    const result = saveBookmarkFromHtml({
      url: body.url, title: body.title, html: body.html, userId,
    });
    return c.json(result);
  } catch (e) {
    if (e?.status) return c.json(e.body, e.status);
    throw e;
  }
});

app.get('/api/bookmarks', (c) => {
  const userId = c.get('userId') ?? null;
  const category = c.req.query('category') || undefined;
  const sort = c.req.query('sort') || undefined;
  return c.json({ items: listBookmarks(db, { category, sort, userId }) });
});

app.get('/api/bookmarks/:id', (c) => {
  const id = Number(c.req.param('id'));
  const b = getBookmark(db, id, { userId: c.get('userId') ?? null });
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json(b);
});

app.patch('/api/bookmarks/:id', async (c) => {
  const denied = requireAuth(c);
  if (denied) return denied;
  const id = Number(c.req.param('id'));
  const userId = c.get('userId') ?? null;
  const b = getBookmark(db, id, { userId });
  if (!b) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  updateMemoAndCategories(db, id, {
    memo: typeof body.memo === 'string' ? body.memo : undefined,
    categories: Array.isArray(body.categories) ? body.categories : undefined,
  });
  return c.json(getBookmark(db, id, { userId }));
});

app.delete('/api/bookmarks/:id', (c) => {
  const denied = requireAuth(c);
  if (denied) return denied;
  const id = Number(c.req.param('id'));
  const userId = c.get('userId') ?? null;
  if (!getBookmark(db, id, { userId })) {
    return c.json({ error: 'not found' }, 404);
  }
  const htmlName = deleteBookmark(db, id);
  if (htmlName) {
    const p = join(HTML_DIR, htmlName);
    try { if (existsSync(p)) unlinkSync(p); } catch {}
  }
  return c.json({ ok: true });
});

app.post('/api/bookmarks/:id/resummarize', async (c) => {
  const denied = requireAuth(c);
  if (denied) return denied;
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
  const b = getBookmark(db, id, { userId: c.get('userId') ?? null });
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

// ---- recommendations ------------------------------------------------------

app.get('/api/recommendations', (c) => {
  const force = c.req.query('force') === '1';
  return c.json({ items: recommendationsFor(db, HTML_DIR, { force }) });
});

app.post('/api/recommendations/dismiss', async (c) => {
  const denied = requireAuth(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => null);
  if (!body?.url) return c.json({ error: 'url required' }, 400);
  dismissRecommendation(db, body.url);
  return c.json({ ok: true });
});

app.delete('/api/recommendations/dismissals', (c) => {
  const denied = requireAuth(c);
  if (denied) return denied;
  clearDismissals(db);
  return c.json({ ok: true });
});

// ---- RAG (semantic search + Q&A) -----------------------------------------

app.get('/api/rag/status', (c) => {
  return c.json({
    enabled: RAG_ENABLED,
    model: getModelName(),
    queue_depth: embeddingQueue.depth,
    queue_running: embeddingQueue.running,
    pending_bookmarks: bookmarksMissingEmbeddings(db).length,
    ...chunkStats(db),
  });
});

app.post('/api/rag/backfill', (c) => {
  const denied = requireAuth(c);
  if (denied) return denied;
  if (!RAG_ENABLED) return c.json({ error: 'RAG disabled (MEMORIA_RAG=0)' }, 503);
  const ids = bookmarksMissingEmbeddings(db);
  for (const id of ids) enqueueEmbedding(id);
  return c.json({ queued: ids.length });
});

app.post('/api/rag/reindex/:id', (c) => {
  const denied = requireAuth(c);
  if (denied) return denied;
  if (!RAG_ENABLED) return c.json({ error: 'RAG disabled' }, 503);
  const id = Number(c.req.param('id'));
  if (!getBookmark(db, id)) return c.json({ error: 'not found' }, 404);
  enqueueEmbedding(id);
  return c.json({ queued: true });
});

app.get('/api/search', async (c) => {
  if (!RAG_ENABLED) return c.json({ error: 'RAG disabled' }, 503);
  const q = c.req.query('q');
  const limit = Number(c.req.query('limit')) || 10;
  if (!q) return c.json({ error: 'q required' }, 400);
  const cache = loadChunkCache();
  if (cache.length === 0) return c.json({ items: [], note: 'No embeddings indexed yet. POST /api/rag/backfill to start.' });
  const qv = await embed(q, 'query');
  const scored = cache.map(c => ({ ...c, score: cosine(qv, c.vec) }));
  scored.sort((a, b) => b.score - a.score);
  // Group by bookmark, keep best-scoring chunk per bookmark.
  const byBm = new Map();
  for (const s of scored) {
    if (!byBm.has(s.bookmark_id)) byBm.set(s.bookmark_id, s);
    if (byBm.size >= limit * 2) break;
  }
  const out = [];
  for (const s of [...byBm.values()].sort((a, b) => b.score - a.score).slice(0, limit)) {
    const b = getBookmark(db, s.bookmark_id);
    if (!b) continue;
    out.push({
      bookmark_id: s.bookmark_id,
      score: Number(s.score.toFixed(4)),
      title: b.title,
      url: b.url,
      summary: b.summary,
      categories: b.categories,
      chunk: s.text.slice(0, 500),
    });
  }
  return c.json({ items: out });
});

app.post('/api/ask', async (c) => {
  const denied = requireAuth(c);
  if (denied) return denied;
  if (!RAG_ENABLED) return c.json({ error: 'RAG disabled' }, 503);
  const body = await c.req.json().catch(() => null);
  const q = body?.q;
  if (!q || typeof q !== 'string') return c.json({ error: 'q required' }, 400);
  const k = Number(body?.k) || 6;

  const cache = loadChunkCache();
  if (cache.length === 0) return c.json({ error: 'no embeddings yet; backfill first' }, 400);

  const qv = await embed(q, 'query');
  const scored = cache.map(c => ({ ...c, score: cosine(qv, c.vec) }));
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const top = [];
  for (const s of scored) {
    if (seen.has(s.bookmark_id)) continue;
    seen.add(s.bookmark_id);
    top.push(s);
    if (top.length >= k) break;
  }

  const sourcesMd = top.map((s, i) => {
    const b = getBookmark(db, s.bookmark_id);
    return `[Source ${i + 1}: ${b?.title ?? `id=${s.bookmark_id}`} (id=${s.bookmark_id}, ${b?.url ?? ''})]\n${s.text}`;
  }).join('\n\n---\n\n');

  const prompt = [
    'You are answering a user question using only the provided sources.',
    '- Cite sources inline as [Source 1], [Source 2] etc.',
    '- If the sources do not contain the answer, say "Not enough context in the saved bookmarks." and stop.',
    '- Reply in the same language as the question.',
    '',
    `QUESTION: ${q}`,
    '',
    'SOURCES:',
    sourcesMd,
  ].join('\n');

  let answer;
  try {
    answer = await claudeAnswer(prompt);
  } catch (e) {
    return c.json({ error: 'claude failed', detail: e.message }, 500);
  }
  return c.json({
    answer,
    sources: top.map((s, i) => {
      const b = getBookmark(db, s.bookmark_id);
      return {
        id: i + 1,
        bookmark_id: s.bookmark_id,
        title: b?.title,
        url: b?.url,
        score: Number(s.score.toFixed(4)),
      };
    }),
  });
});

function claudeAnswer(prompt, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ['-p', prompt], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude CLI timed out')); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`));
      else resolve(stdout.trim());
    });
  });
}

// ---- dig (deep research) -------------------------------------------------

const digQueue = new FifoQueue();

function enqueueDig(id, query, userId = null) {
  digQueue.enqueue(async () => {
    try {
      const result = await runDig({ query, claudeBin: CLAUDE_BIN });
      setDigResult(db, id, { status: 'done', result });
      emitEvent('memoria.dig.completed', {
        userId,
        payload: { session_id: id, query, source_count: result.sources.length },
      });
    } catch (e) {
      setDigResult(db, id, { status: 'error', error: e.message.slice(0, 500) });
      throw e;
    }
  }, { kind: 'dig', sessionId: id, title: query });
}

app.post('/api/dig', async (c) => {
  const denied = requireAuth(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => null);
  const query = body?.query;
  if (!query || typeof query !== 'string') return c.json({ error: 'query required' }, 400);
  const id = insertDigSession(db, query);
  enqueueDig(id, query, c.get('userId') ?? null);
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
  const denied = requireAuth(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.urls)) return c.json({ error: 'urls[] required' }, 400);
  return c.json({ results: await bulkSaveUrls(body.urls, { userId: c.get('userId') ?? null }) });
});

// ---- queue status ---------------------------------------------------------

app.get('/api/queue', (c) => {
  return c.json({
    depth: summaryQueue.depth,
    running: summaryQueue.running,
    embedding_depth: embeddingQueue.depth,
    embedding_running: embeddingQueue.running,
  });
});

app.get('/api/queue/items', (c) => {
  return c.json({
    summary: summaryQueue.snapshot(),
    embedding: embeddingQueue.snapshot(),
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
  // In online mode the visit-tracking surface is intentionally disabled —
  // the privacy contract is that we don't aggregate non-bookmarked URLs
  // server-side for shared deployments.
  if (ONLINE) return c.json({ matched: false, disabled: true });

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.url !== 'string') return c.json({ error: 'url required' }, 400);
  if (!/^https?:\/\//.test(body.url)) return c.json({ matched: false, ignored: true });

  upsertVisit(db, { url: body.url, title: typeof body.title === 'string' ? body.title : null });

  const b = findBookmarkByUrl(db, body.url);
  if (!b) return c.json({ matched: false });
  recordAccess(db, b.id);
  return c.json({ matched: true, id: b.id });
});

// ---- visit history (unsaved URLs) -----------------------------------------
// All visit-history endpoints are local-only: they expose the user's raw
// browsing trail and have no place in a multi-user deployment.

app.get('/api/visits/unsaved', blockInOnline, (c) => {
  const since = c.req.query('since');
  return c.json({ items: listUnsavedVisits(db, { since }) });
});

app.get('/api/visits/suggested', blockInOnline, (c) => {
  const days = Number(c.req.query('days')) || 30;
  return c.json({ items: listSuggestedVisits(db, { sinceDays: days }) });
});

app.get('/api/visits/unsaved/count', blockInOnline, (c) => {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM page_visits v
    LEFT JOIN bookmarks b ON b.url = v.url
    WHERE b.id IS NULL
      AND date(v.last_seen_at, 'localtime') = date('now', 'localtime')
  `).get();
  return c.json({ count: row?.n ?? 0 });
});

app.delete('/api/visits', blockInOnline, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.urls)) return c.json({ error: 'urls[] required' }, 400);
  for (const url of body.urls) deleteVisit(db, url);
  return c.json({ ok: true, removed: body.urls.length });
});

async function bulkSaveUrls(urls, { userId = null } = {}) {
  const results = [];
  for (const url of urls) {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      results.push({ url, status: 'skipped', error: 'invalid url' });
      continue;
    }
    const existing = findBookmarkByUrl(db, url, { userId });
    if (existing) {
      deleteVisit(db, url);
      results.push({ url, status: 'duplicate', id: existing.id });
      continue;
    }
    try {
      const visit = db.prepare(`SELECT title FROM page_visits WHERE url = ?`).get(url);
      const fetched = await fetchPageHtml(url);
      const title = (visit?.title || fetched.title || url).slice(0, 500);

      const filt = checkContent({ url, title, html: fetched.html });
      if (!filt.ok) {
        results.push({ url, status: 'blocked', reason: filt.reason, matches: filt.matches });
        continue;
      }

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const safe = ts + '_' + Math.random().toString(36).slice(2, 8) + '.html';
      writeFileSync(join(HTML_DIR, safe), fetched.html, 'utf8');

      const id = insertBookmark(db, { url, title, htmlPath: safe, userId });
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

app.post('/api/visits/bookmark', blockInOnline, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.urls)) return c.json({ error: 'urls[] required' }, 400);
  return c.json({ results: await bulkSaveUrls(body.urls, { userId: c.get('userId') ?? null }) });
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
  const denied = requireAuth(c);
  if (denied) return denied;
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
  const denied = requireAuth(c);
  if (denied) return denied;
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

// ---- static UI ------------------------------------------------------------

app.use('/*', serveStatic({ root: './public' }));
app.get('/', serveStatic({ path: './public/index.html' }));

serve({ fetch: app.fetch, port: PORT }, async (info) => {
  console.log(`Memoria server listening on http://localhost:${info.port}`);
  console.log(`  mode: ${MODE}${ONLINE ? ' (auth required)' : ' (no auth)'}`);
  console.log(`  data dir: ${DATA_DIR}`);
  console.log(`  claude bin: ${CLAUDE_BIN}`);
  console.log(`  rag: ${RAG_ENABLED ? 'enabled' : 'disabled'}`);

  // Boot Cernere adapters last so the HTTP API is already accepting requests
  // when admission events start arriving.
  try {
    await startCernere({
      upsertUser: async (user) => {
        // Memoria tracks the user_id only — personal data lives in Cernere
        // (per LUDIARS personal-data rule). We don't need a users table.
        console.log(`[memoria] admission: ${user.id} (${user.login})`);
      },
      revokeUser: async (uid) => {
        console.log(`[memoria] revoke: ${uid}`);
      },
      peerHandlers: buildPeerHandlers(),
    });
  } catch (e) {
    console.error('[memoria] cernere start failed:', e);
  }
});

process.on('SIGINT', async () => { await stopCernere(); process.exit(0); });
process.on('SIGTERM', async () => { await stopCernere(); process.exit(0); });

// ---- peer handlers ---------------------------------------------------------
//
// These are the surface other LUDIARS services (Imperativus etc.) call into.
// All take an explicit user_id in the payload — the peer channel is server-
// to-server, so the caller must already know who the request is for.

function buildPeerHandlers() {
  const requireUserId = (p) => {
    if (!p?.user_id || typeof p.user_id !== 'string') {
      throw new Error('user_id required');
    }
    return p.user_id;
  };

  return {
    'memoria.search': async (_caller, p) => {
      const userId = requireUserId(p);
      const items = listBookmarks(db, { userId });
      const q = String(p.query ?? '').toLowerCase();
      if (!q) return { items: items.slice(0, p.limit ?? 20) };
      const filtered = items.filter(b =>
        (b.title || '').toLowerCase().includes(q) ||
        (b.url || '').toLowerCase().includes(q) ||
        (b.summary || '').toLowerCase().includes(q) ||
        (b.memo || '').toLowerCase().includes(q)
      ).slice(0, p.limit ?? 20);
      return { items: filtered };
    },
    'memoria.save_url': async (_caller, p) => {
      const userId = requireUserId(p);
      const url = String(p.url ?? '');
      if (!/^https?:\/\//.test(url)) throw new Error('valid http(s) url required');
      const [r] = await bulkSaveUrls([url], { userId });
      return r;
    },
    'memoria.save_html': async (_caller, p) => {
      // Caller already supplies the rendered HTML (typically the Chrome
      // extension forwarded by Imperativus). user_id comes from the verified
      // peer JWT — the FE/extension cannot impersonate.
      const userId = requireUserId(p);
      try {
        return saveBookmarkFromHtml({
          url: String(p.url ?? ''),
          title: String(p.title ?? ''),
          html: String(p.html ?? ''),
          userId,
        });
      } catch (e) {
        if (e?.body) {
          const err = new Error(e.body.error || 'rejected');
          err.body = e.body;
          throw err;
        }
        throw e;
      }
    },
    'memoria.list_categories': async (_caller, _p) => {
      return { items: listAllCategories(db) };
    },
    'memoria.recent_bookmarks': async (_caller, p) => {
      const userId = requireUserId(p);
      const items = listBookmarks(db, { userId, sort: 'created_desc' });
      return { items: items.slice(0, p.limit ?? 10) };
    },
    'memoria.get_bookmark': async (_caller, p) => {
      const userId = requireUserId(p);
      const id = Number(p.id);
      const b = getBookmark(db, id, { userId });
      if (!b) throw new Error('not found');
      return b;
    },
    'memoria.dig': async (_caller, p) => {
      const userId = requireUserId(p);
      const query = String(p.query ?? '');
      if (!query) throw new Error('query required');
      const id = insertDigSession(db, query);
      enqueueDig(id, query, userId);
      return { id, queued: true };
    },
    'memoria.unsaved_visits': async (_caller, p) => {
      // Local-only feature — explicit refusal in online mode mirrors the HTTP
      // surface so Imperativus can show a clear error to the user.
      if (ONLINE) throw new Error('unsaved_visits is disabled in online mode');
      return { items: listSuggestedVisits(db, { sinceDays: Number(p?.days) || 7 }) };
    },
  };
}
