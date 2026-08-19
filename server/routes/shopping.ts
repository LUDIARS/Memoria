import type BetterSqlite3 from 'better-sqlite3';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { isSameMachineRequest } from '../lib/local-request.js';
import {
  getShoppingConfig,
  getShoppingDigest,
  setShoppingConfig,
  shoppingConfigSchema,
} from '../shopping/config.js';
import {
  shoppingCrawlCoordinator,
  type ShoppingCrawlCoordinator,
} from '../shopping/crawl-coordinator.js';
import { refreshShoppingDigest, searchShopping } from '../shopping/service.js';
import type { ShoppingDigest, ShoppingSearchResult } from '../shopping/types.js';

type Db = BetterSqlite3.Database;

export interface ShoppingRouterDeps {
  db: Db;
  refreshDigest?: (db: Db) => Promise<ShoppingDigest>;
  search?: (db: Db, query: string) => Promise<ShoppingSearchResult>;
  coordinator?: ShoppingCrawlCoordinator;
}

const searchSchema = z.object({
  query: z.string().trim().min(1).max(120),
});

export function makeShoppingRouter(deps: ShoppingRouterDeps): Hono {
  const router = new Hono();
  const refreshDigest = deps.refreshDigest ?? refreshShoppingDigest;
  const runSearch = deps.search ?? searchShopping;
  const coordinator = deps.coordinator ?? shoppingCrawlCoordinator;

  router.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    if (!isSameMachineRequest(context)) {
      return context.json({ error: 'same-machine access required' }, 403);
    }
    await next();
  });

  router.get('/api/shopping/config', (context: Context) => context.json(getShoppingConfig(deps.db)));

  router.put('/api/shopping/config', async (context: Context) => {
    const body = await context.req.json().catch(() => null);
    const parsed = shoppingConfigSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'invalid shopping config', issues: parsed.error.issues }, 400);
    return context.json(setShoppingConfig(deps.db, parsed.data));
  });

  router.get('/api/shopping/deals', (context: Context) => context.json({ digest: getShoppingDigest(deps.db) }));

  router.post('/api/shopping/deals/refresh', async (context: Context) => {
    const request = coordinator.requestRefresh(() => refreshDigest(deps.db));
    if (request.status === 'busy') return context.json({ error: 'shopping crawl already running' }, 409);
    return context.json({ digest: await request.promise });
  });

  router.post('/api/shopping/search', async (context: Context) => {
    const body = await context.req.json().catch(() => null);
    const parsed = searchSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: '商品名を1〜120文字で入力してください' }, 400);
    const request = coordinator.requestSearch(parsed.data.query, () => runSearch(deps.db, parsed.data.query));
    if (request.status === 'busy') {
      context.header('Retry-After', '5');
      return context.json({ error: 'shopping crawl already running' }, 429);
    }
    return context.json(await request.promise);
  });

  return router;
}
