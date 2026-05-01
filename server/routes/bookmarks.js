// Bookmarks router (mounted at `/api` so it can serve both `/api/bookmark`
// (singular POST) and `/api/bookmarks/...` plural CRUD).
//
// Extracted from server/index.js as part of the per-domain router split.
// Closures over `db`, queues, helper functions, etc. are passed in via the
// factory `deps` argument so this file doesn't depend on index.js's
// module-scope state.
import { Hono } from 'hono';
import { join } from 'node:path';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';

export function createBookmarksRouter({
  db,
  HTML_DIR,
  insertBookmark,
  setSummary,
  listBookmarks,
  countBookmarks,
  getBookmark,
  updateMemoAndCategories,
  deleteBookmark,
  recordAccess,
  findBookmarkByUrl,
  listAccesses,
  getBookmarkWordCloud,
  insertWordCloud,
  enqueueSummary,
  enqueueCloud,
  buildBookmarkDoc,
  summaryQueue,
}) {
  const router = new Hono();

  // ---- bookmark CRUD ------------------------------------------------------

  router.post('/bookmark', async (c) => {
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

  router.get('/bookmarks', (c) => {
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

  router.get('/bookmarks/:id', (c) => {
    const id = Number(c.req.param('id'));
    const b = getBookmark(db, id);
    if (!b) return c.json({ error: 'not found' }, 404);
    const cloud = getBookmarkWordCloud(db, id);
    return c.json({ ...b, wordcloud: cloud });
  });

  router.patch('/bookmarks/:id', async (c) => {
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

  router.delete('/bookmarks/:id', (c) => {
    const id = Number(c.req.param('id'));
    const htmlName = deleteBookmark(db, id);
    if (htmlName) {
      const p = join(HTML_DIR, htmlName);
      try { if (existsSync(p)) unlinkSync(p); } catch {}
    }
    return c.json({ ok: true });
  });

  router.post('/bookmarks/:id/resummarize', async (c) => {
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

  router.get('/bookmarks/:id/html', (c) => {
    const id = Number(c.req.param('id'));
    const b = getBookmark(db, id);
    if (!b) return c.text('not found', 404);
    const p = join(HTML_DIR, b.html_path);
    if (!existsSync(p)) return c.text('html missing', 404);
    return c.body(readFileSync(p), 200, { 'Content-Type': 'text/html; charset=utf-8' });
  });

  router.get('/bookmarks/:id/accesses', (c) => {
    const id = Number(c.req.param('id'));
    return c.json({ items: listAccesses(db, id) });
  });

  // Per-bookmark word cloud (default: not generated; on-demand).
  router.post('/bookmarks/:id/wordcloud', async (c) => {
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

  router.get('/bookmarks/:id/wordcloud', (c) => {
    const id = Number(c.req.param('id'));
    if (!getBookmark(db, id)) return c.json({ error: 'not found' }, 404);
    const cloud = getBookmarkWordCloud(db, id);
    return c.json({ cloud });
  });

  return router;
}
