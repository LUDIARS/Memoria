import { Hono } from 'hono';
import type { RailStatusCache } from './cache.js';

export function makeRailStatusRouter(cache: Pick<RailStatusCache, 'state'>): Hono {
  const router = new Hono();
  router.get('/api/rail-status/kanto', c => {
    c.header('Cache-Control', 'no-store');
    return c.json(cache.state());
  });
  return router;
}
