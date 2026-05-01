// Recommendations router (mounted at `/api/recommendations`).
import { Hono } from 'hono';

export function createRecommendationsRouter({
  db,
  HTML_DIR,
  recommendationsFor,
  dismissRecommendation,
  clearDismissals,
}) {
  const router = new Hono();

  router.get('/', (c) => {
    const force = c.req.query('force') === '1';
    return c.json({ items: recommendationsFor(db, HTML_DIR, { force }) });
  });

  router.post('/dismiss', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.url) return c.json({ error: 'url required' }, 400);
    dismissRecommendation(db, body.url);
    return c.json({ ok: true });
  });

  router.delete('/dismissals', (c) => {
    clearDismissals(db);
    return c.json({ ok: true });
  });

  return router;
}
