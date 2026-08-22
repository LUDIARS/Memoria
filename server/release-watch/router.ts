import type BetterSqlite3 from 'better-sqlite3';
import { Hono, type Context } from 'hono';
import { isSameMachineRequest } from '../lib/local-request.js';
import {
  findSource,
  getReleaseDigest,
  getReleaseWatchConfig,
  releaseWatchConfigSchema,
  setReleaseWatchConfig,
} from './config.js';
import { releaseCrawlCoordinator, type ReleaseCrawlCoordinator } from './coordinator.js';
import { refreshReleaseDigest } from './service.js';
import type { ReleaseDigest } from './types.js';

type Db = BetterSqlite3.Database;

export interface ReleaseWatchRouterDeps {
  db: Db;
  refresh?: (db: Db, onlySourceId?: string) => Promise<ReleaseDigest>;
  coordinator?: ReleaseCrawlCoordinator;
}

export function makeReleaseWatchRouter(deps: ReleaseWatchRouterDeps): Hono {
  const router = new Hono();
  const refresh = deps.refresh ?? ((db: Db, onlySourceId?: string) => refreshReleaseDigest(db, new Date(), {}, onlySourceId));
  const coordinator = deps.coordinator ?? releaseCrawlCoordinator;

  router.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    if (!isSameMachineRequest(context)) return context.json({ error: 'same-machine access required' }, 403);
    await next();
  });

  router.get('/api/release-watch/config', (context: Context) => context.json(getReleaseWatchConfig(deps.db)));

  router.put('/api/release-watch/config', async (context: Context) => {
    const body = await context.req.json().catch(() => null);
    const parsed = releaseWatchConfigSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'invalid release-watch config', issues: parsed.error.issues }, 400);
    return context.json(setReleaseWatchConfig(deps.db, parsed.data));
  });

  router.get('/api/release-watch/digest', (context: Context) => context.json({
    digest: getReleaseDigest(deps.db),
    busy: coordinator.busy,
  }));

  router.post('/api/release-watch/refresh', async (context: Context) => {
    const sourceId = context.req.query('source') || undefined;
    if (sourceId && !findSource(getReleaseWatchConfig(deps.db), sourceId)) {
      return context.json({ error: 'unknown source' }, 404);
    }
    const request = coordinator.request(() => refresh(deps.db, sourceId));
    if (request.status === 'busy') return context.json({ error: 'release crawl already running' }, 409);
    return context.json({ digest: await request.promise });
  });

  return router;
}
