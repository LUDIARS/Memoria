import type BetterSqlite3 from 'better-sqlite3';
import { getShoppingConfig, getShoppingDigest } from './config.js';
import {
  shoppingCrawlCoordinator,
  type ShoppingCrawlCoordinator,
  type ShoppingCrawlRequest,
} from './crawl-coordinator.js';
import { refreshShoppingDigest } from './service.js';
import type { ShoppingConfig, ShoppingDigest } from './types.js';

type Db = BetterSqlite3.Database;

const RETRY_INTERVAL_MS = 30 * 60 * 1000;

interface ScheduledRefreshDeps {
  coordinator?: ShoppingCrawlCoordinator;
  refreshDigest?: (db: Db, now: Date) => Promise<ShoppingDigest>;
}

function localDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function shouldRefreshShoppingDigest(
  config: ShoppingConfig,
  latestDigestDate: string | null,
  now: Date,
  lastAttemptAt: number,
): boolean {
  if (!config.enabled || config.sources.every((source) => !source.enabled)) return false;
  if (now.getHours() < config.refreshHour) return false;
  if (latestDigestDate === localDate(now)) return false;
  return now.getTime() - lastAttemptAt >= RETRY_INTERVAL_MS;
}

export function requestScheduledShoppingRefresh(
  db: Db,
  now: Date,
  deps: ScheduledRefreshDeps = {},
): ShoppingCrawlRequest<ShoppingDigest> {
  const coordinator = deps.coordinator ?? shoppingCrawlCoordinator;
  const refreshDigest = deps.refreshDigest ?? refreshShoppingDigest;
  return coordinator.requestRefresh(() => refreshDigest(db, now));
}

export function startShoppingScheduler(db: Db): void {
  let lastAttemptAt = 0;
  const tick = async (): Promise<void> => {
    try {
      const config = getShoppingConfig(db);
      const now = new Date();
      if (!shouldRefreshShoppingDigest(config, getShoppingDigest(db)?.date ?? null, now, lastAttemptAt)) return;
      const request = requestScheduledShoppingRefresh(db, now);
      if (request.status === 'busy') return;
      lastAttemptAt = now.getTime();
      await request.promise;
    } catch (error: unknown) {
      console.warn('[shopping] daily crawl failed:', error instanceof Error ? error.message : String(error));
    }
  };
  setTimeout(() => { void tick(); }, 25_000).unref?.();
  setInterval(() => { void tick(); }, 60_000).unref?.();
}
