import { Hono } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { isSameMachineRequest } from '../lib/local-request.js';
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
    // Accept requests forwarded by the configured Access host while retaining
    // the local peer and same-origin checks for direct access and CSRF.
    if (!isSameMachineRequest(context)) {
      return context.json({ error: 'same-machine access required' }, 403);
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
