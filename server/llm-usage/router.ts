import { Hono } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { isSameMachineRequest } from '../lib/local-request.js';
import { usageDashboard } from './dashboard.js';
import { ensureLlmUsageSchema } from './schema.js';
import { UsageSyncCoordinator } from './sync.js';
import { InvalidPeriodError, parseUsagePeriod, type UsagePeriod } from './usage-period.js';
import { fetchRemainingUsage, parseRemainingRange, parseRemainingStart } from './remaining.js';

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

  router.get('/api/llm-usage', (context) => {
    let period: UsagePeriod;
    try {
      period = parseUsagePeriod(context.req.query('from'), context.req.query('to'));
    } catch (error: unknown) {
      if (error instanceof InvalidPeriodError) return context.json({ error: error.message }, 400);
      throw error;
    }
    return context.json({
      ...usageDashboard(db, period),
      sync: coordinator.status(),
    });
  });
  router.get('/api/llm-usage/sync', (context) => context.json(coordinator.status()));
  router.get('/api/llm-usage/remaining', async (context) => {
    let range: ReturnType<typeof parseRemainingRange>;
    let from: number | undefined;
    try {
      range = parseRemainingRange(context.req.query('range'));
      from = parseRemainingStart(context.req.query('from'), Math.floor(Date.now() / 1000));
    } catch (error: unknown) {
      if (error instanceof RangeError) return context.json({ error: error.message }, 400);
      throw error;
    }
    try {
      return context.json(await fetchRemainingUsage({ range, from }));
    } catch (error: unknown) {
      // Network errors may contain the configured endpoint. Expose only known safe messages.
      const detail = error instanceof Error && /^(Concordia の|Concordia が)/.test(error.message)
        ? error.message : 'Concordia から残量を取得できませんでした';
      return context.json({ error: detail }, 502);
    }
  });
  router.post('/api/llm-usage/sync', (context) => context.json(coordinator.start(), 202));
  return router;
}
