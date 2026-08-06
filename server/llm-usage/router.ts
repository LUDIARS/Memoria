import { Hono } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { isDirectLoopbackRequest } from '../lib/local-request.js';
import { ensureLlmUsageSchema } from './schema.js';
import { usageDashboard } from './store.js';
import { UsageSyncCoordinator } from './sync.js';

type Db = BetterSqlite3.Database;

export function makeLlmUsageRouter({ db }: { db: Db }): Hono {
  ensureLlmUsageSchema(db);
  const coordinator = new UsageSyncCoordinator(db);
  const router = new Hono();

  router.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    if (!isDirectLoopbackRequest(context)) {
      return context.json({ error: 'direct loopback access required' }, 403);
    }
    await next();
  });

  router.get('/api/llm-usage', (context) => context.json({
    ...usageDashboard(db),
    sync: coordinator.status(),
  }));
  router.get('/api/llm-usage/sync', (context) => context.json(coordinator.status()));
  router.post('/api/llm-usage/sync', (context) => context.json(coordinator.start(), 202));
  return router;
}
