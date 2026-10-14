import type BetterSqlite3 from 'better-sqlite3';
import { getTrendCrawlerConfig } from './config.js';
import { trendCrawlCoordinator, type TrendCrawlCoordinator } from './coordinator.js';
import { crawlTrends } from './service.js';
import { lastCrawledAt } from './store.js';
import type { TrendCrawlerConfig, TrendCrawlResult } from './types.js';

type Db = BetterSqlite3.Database;

const HOUR_MS = 60 * 60 * 1000;
/** 失敗 (例外) 時に同じ巡回を叩き直さない間隔。 */
const RETRY_INTERVAL_MS = 30 * 60 * 1000;

/** 前回の巡回から intervalHours 経っていれば巡回する。 直前の試行から 30 分は空ける。 */
export function shouldCrawlTrends(
  config: TrendCrawlerConfig,
  lastCrawled: string | null,
  now: Date,
  lastAttemptAt: number,
): boolean {
  if (!config.enabled || config.sources.every((source) => !source.enabled)) return false;
  if (now.getTime() - lastAttemptAt < RETRY_INTERVAL_MS) return false;
  if (lastCrawled === null) return true;
  const last = Date.parse(lastCrawled);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= config.intervalHours * HOUR_MS;
}

export function requestScheduledTrendCrawl(
  db: Db,
  now: Date,
  deps: { coordinator?: TrendCrawlCoordinator; crawl?: (db: Db, now: Date) => Promise<TrendCrawlResult> } = {},
): ReturnType<TrendCrawlCoordinator['request']> {
  const coordinator = deps.coordinator ?? trendCrawlCoordinator;
  const crawl = deps.crawl ?? ((d: Db, n: Date) => crawlTrends(d, n));
  return coordinator.request(() => crawl(db, now));
}

export function startTrendCrawlerScheduler(db: Db): void {
  let lastAttemptAt = 0;
  const tick = async (): Promise<void> => {
    try {
      const now = new Date();
      if (!shouldCrawlTrends(getTrendCrawlerConfig(db), lastCrawledAt(db), now, lastAttemptAt)) return;
      const request = requestScheduledTrendCrawl(db, now);
      if (request.status === 'busy') return;
      lastAttemptAt = now.getTime();
      const result = await request.promise;
      if (result.failed.length) {
        console.warn(`[trend-crawler] ${result.failed.length} source(s) failed:`, result.failed.map((f) => f.sourceId).join(', '));
      }
    } catch (error: unknown) {
      console.warn('[trend-crawler] crawl failed:', error instanceof Error ? error.message : String(error));
    }
  };
  setTimeout(() => { void tick(); }, 60_000).unref?.();
  setInterval(() => { void tick(); }, 5 * 60_000).unref?.();
}
