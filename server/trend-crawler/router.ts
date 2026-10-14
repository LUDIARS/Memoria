import type BetterSqlite3 from 'better-sqlite3';
import { Hono, type Context } from 'hono';
import { isSameMachineRequest } from '../lib/local-request.js';
import {
  findTrendSource,
  getTrendCrawlerConfig,
  getTrendSummary,
  setTrendCrawlerConfig,
  trendCrawlerConfigSchema,
} from './config.js';
import { trendCrawlCoordinator, type TrendCrawlCoordinator } from './coordinator.js';
import { buildTrendOverview } from './overview.js';
import { crawlTrends } from './service.js';
import type { TrendCrawlerConfig, TrendCrawlResult, TrendOverview } from './types.js';

type Db = BetterSqlite3.Database;

export interface TrendCrawlerRouterDeps {
  db: Db;
  crawl?: (db: Db, onlySourceId?: string) => Promise<TrendCrawlResult>;
  overview?: (db: Db) => TrendOverview;
  coordinator?: TrendCrawlCoordinator;
}

export function makeTrendCrawlerRouter(deps: TrendCrawlerRouterDeps): Hono {
  const router = new Hono();
  const crawl = deps.crawl ?? ((db: Db, onlySourceId?: string) => crawlTrends(db, new Date(), {}, onlySourceId));
  const overview = deps.overview ?? ((db: Db) => buildTrendOverview(db, getTrendCrawlerConfig(db), getTrendSummary(db)));
  const coordinator = deps.coordinator ?? trendCrawlCoordinator;

  router.use('/api/trend-crawler/*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    if (!isSameMachineRequest(context)) return context.json({ error: 'same-machine access required' }, 403);
    await next();
  });

  router.get('/api/trend-crawler/config', (context: Context) => context.json(getTrendCrawlerConfig(deps.db)));

  router.put('/api/trend-crawler/config', async (context: Context) => {
    const body = await context.req.json().catch(() => null);
    const parsed = trendCrawlerConfigSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'invalid trend-crawler config', issues: parsed.error.issues }, 400);
    return context.json(setTrendCrawlerConfig(deps.db, parsed.data as TrendCrawlerConfig));
  });

  router.get('/api/trend-crawler/overview', (context: Context) => context.json({
    overview: overview(deps.db),
    busy: coordinator.busy,
  }));

  router.post('/api/trend-crawler/refresh', async (context: Context) => {
    const sourceId = context.req.query('source') || undefined;
    if (sourceId && !findTrendSource(getTrendCrawlerConfig(deps.db), sourceId)) {
      return context.json({ error: 'unknown source' }, 404);
    }
    const request = coordinator.request(() => crawl(deps.db, sourceId));
    if (request.status === 'busy') return context.json({ error: 'trend crawl already running' }, 409);
    const result = await request.promise;
    return context.json({ result, overview: overview(deps.db) });
  });

  return router;
}
