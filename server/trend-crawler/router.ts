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
import { clickInputSchema, clickStats, getInterestPrefs, interestPrefsSchema, recordClick, setInterestPrefs } from './interest-store.js';
import type { TrendInterestPrefs } from './interest.js';
import { buildTrendMap, type TrendMap } from './map.js';
import { buildTrendOverview } from './overview.js';
import { crawlTrends } from './service.js';
import type { TrendCrawlerConfig, TrendCrawlResult, TrendGenre, TrendOverview } from './types.js';

type Db = BetterSqlite3.Database;

export interface TrendCrawlerRouterDeps {
  db: Db;
  crawl?: (db: Db, onlySourceId?: string) => Promise<TrendCrawlResult>;
  overview?: (db: Db) => TrendOverview;
  map?: (db: Db) => TrendMap;
  coordinator?: TrendCrawlCoordinator;
}

export function makeTrendCrawlerRouter(deps: TrendCrawlerRouterDeps): Hono {
  const router = new Hono();
  const crawl = deps.crawl ?? ((db: Db, onlySourceId?: string) => crawlTrends(db, new Date(), {}, onlySourceId));
  const overview = deps.overview ?? ((db: Db) => buildTrendOverview(db, getTrendCrawlerConfig(db), getTrendSummary(db)));
  const coordinator = deps.coordinator ?? trendCrawlCoordinator;
  const map = deps.map ?? ((db: Db) => buildTrendMap(overview(db), getInterestPrefs(db), clickStats(db)));

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

  router.get('/api/trend-crawler/map', (context: Context) => context.json({ map: map(deps.db), busy: coordinator.busy }));

  router.get('/api/trend-crawler/interest', (context: Context) => context.json(getInterestPrefs(deps.db)));

  router.put('/api/trend-crawler/interest', async (context: Context) => {
    const body = await context.req.json().catch(() => null);
    const parsed = interestPrefsSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'invalid interest prefs', issues: parsed.error.issues }, 400);
    return context.json(setInterestPrefs(deps.db, parsed.data as TrendInterestPrefs));
  });

  router.post('/api/trend-crawler/click', async (context: Context) => {
    const body = await context.req.json().catch(() => null);
    const parsed = clickInputSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'invalid click', issues: parsed.error.issues }, 400);
    recordClick(deps.db, { ...parsed.data, genre: parsed.data.genre as TrendGenre });
    return context.json({ ok: true });
  });

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
