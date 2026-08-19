import { Hono } from 'hono';
import { isSameMachineRequest } from '../lib/local-request.js';
import { makeSpendingAdviceRouter } from './advice-router.js';
import { makeSpendingInsightRouter } from './insight-router.js';
import { ensureSpendingLogSchema } from './schema.js';
import { makeSpendingSyncRouter } from './sync-router.js';
import type { SpendingLogRouterDeps } from './router-deps.js';

export type { SpendingLogRouterDeps } from './router-deps.js';

/**
 * spending log 系ルータの合成と、 全経路に共通の同一マシン制限だけを持つ。
 * 個々の処理は sync / insight / advice の各サブルータが担当する。
 */
export function makeSpendingLogRouter(deps: SpendingLogRouterDeps): Hono {
  ensureSpendingLogSchema(deps.db);
  const router = new Hono();

  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    // Accept requests forwarded by the configured Access host while retaining
    // the local peer and same-origin checks for direct access and CSRF.
    if (!isSameMachineRequest(c)) {
      return c.json({ error: 'same-machine access required' }, 403);
    }
    await next();
  });

  // /api/spending-logs/... の具体パスを先に登録し、 一覧の /api/spending-logs と
  // 衝突しないようにする。
  router.route('/', makeSpendingInsightRouter(deps));
  router.route('/', makeSpendingAdviceRouter(deps));
  router.route('/', makeSpendingSyncRouter(deps));

  return router;
}
