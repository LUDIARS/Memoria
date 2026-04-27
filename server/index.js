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
} from './db.js';
import { summarizeWithClaude } from './claude.js';
import { FifoQueue } from './queue.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MEMORIA_PORT ?? 5180);
const DATA_DIR = resolve(process.env.MEMORIA_DATA ?? join(__dirname, '..', 'data'));
const HTML_DIR = join(DATA_DIR, 'html');
const DB_PATH = join(DATA_DIR, 'memoria.db');
const CLAUDE_BIN = process.env.MEMORIA_CLAUDE_BIN ?? 'claude';

mkdirSync(HTML_DIR, { recursive: true });
const db = openDb(DB_PATH);
const summaryQueue = new FifoQueue();

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
  return c.json(b);
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

// ---- queue status ---------------------------------------------------------

app.get('/api/queue', (c) => {
  return c.json({ depth: summaryQueue.depth, running: summaryQueue.running });
});

app.get('/api/queue/items', (c) => {
  return c.json(summaryQueue.snapshot());
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

  // Always upsert into page_visits so unsaved URLs are tracked too.
  upsertVisit(db, { url: body.url, title: typeof body.title === 'string' ? body.title : null });

  // If this URL is already bookmarked, also bump its bookmark access counter.
  const b = findBookmarkByUrl(db, body.url);
  if (!b) return c.json({ matched: false });
  recordAccess(db, b.id);
  return c.json({ matched: true, id: b.id });
});

// ---- visit history (unsaved URLs) -----------------------------------------

app.get('/api/visits/unsaved', (c) => {
  const since = c.req.query('since');
  return c.json({ items: listUnsavedVisits(db, { since }) });
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

app.post('/api/visits/bookmark', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.urls)) return c.json({ error: 'urls[] required' }, 400);

  const results = [];
  for (const url of body.urls) {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      results.push({ url, status: 'skipped', error: 'invalid url' });
      continue;
    }
    const existing = findBookmarkByUrl(db, url);
    if (existing) {
      // Already bookmarked → just clean up the visit row.
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
      // Visit row no longer needed once bookmarked.
      deleteVisit(db, url);
      results.push({ url, status: 'queued', id });
    } catch (e) {
      results.push({ url, status: 'error', error: e.message });
    }
  }
  return c.json({ results });
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

// ---- static UI ------------------------------------------------------------

app.use('/*', serveStatic({ root: './public' }));
app.get('/', serveStatic({ path: './public/index.html' }));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Memoria server listening on http://localhost:${info.port}`);
  console.log(`  data dir: ${DATA_DIR}`);
  console.log(`  claude bin: ${CLAUDE_BIN}`);
});
