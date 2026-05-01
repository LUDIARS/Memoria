// Dig (deep research) router (mounted at `/api/dig`).
//
// `enqueueDig` and `bulkSaveUrls` are passed in via deps because both close
// over module-scope queues / helpers in index.js.
import { Hono } from 'hono';

export function createDigRouter({
  db,
  insertDigSession,
  getDigSession,
  listDigSessions,
  deleteDigSession,
  listDigThemes,
  listSearchEngines,
  deriveDigTheme,
  enqueueDig,
  bulkSaveUrls,
}) {
  const router = new Hono();

  router.post('/', async (c) => {
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

  router.get('/engines', (c) => {
    return c.json({ items: listSearchEngines() });
  });

  router.get('/themes', (c) => {
    return c.json({ items: listDigThemes(db) });
  });

  router.get('/', (c) => {
    const theme = c.req.query('theme');
    return c.json({ items: listDigSessions(db, theme ? { theme } : {}) });
  });

  router.get('/:id', (c) => {
    const id = Number(c.req.param('id'));
    const s = getDigSession(db, id);
    if (!s) return c.json({ error: 'not found' }, 404);
    return c.json(s);
  });

  // Delete a 誤 Dig. The row goes; downstream references (word_clouds
  // origin_dig_id, dictionary_links source_kind='dig') become orphan and the
  // existing UI handles missing sessions gracefully.
  router.delete('/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const removed = deleteDigSession(db, id);
    if (!removed) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true, id });
  });

  router.post('/:id/save', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.urls)) return c.json({ error: 'urls[] required' }, 400);
    return c.json({ results: await bulkSaveUrls(body.urls) });
  });

  return router;
}
