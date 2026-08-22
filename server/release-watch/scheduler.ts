import type BetterSqlite3 from 'better-sqlite3';
import { getReleaseDigest, getReleaseWatchConfig } from './config.js';
import { releaseCrawlCoordinator, type ReleaseCrawlCoordinator, type ReleaseCrawlRequest } from './coordinator.js';
import { refreshReleaseDigest } from './service.js';
import type { ReleaseDigest, ReleaseWatchConfig } from './types.js';

type Db = BetterSqlite3.Database;

const RETRY_INTERVAL_MS = 30 * 60 * 1000;

function localDate(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 毎日 refreshHour 以降に 1 回。 失敗時は 30 分おきに再試行。 */
export function shouldRefreshReleases(
  config: ReleaseWatchConfig,
  latestDigestDate: string | null,
  now: Date,
  lastAttemptAt: number,
): boolean {
  if (!config.enabled || config.sources.every((s) => !s.enabled)) return false;
  if (now.getHours() < config.refreshHour) return false;
  if (latestDigestDate === localDate(now)) return false;
  return now.getTime() - lastAttemptAt >= RETRY_INTERVAL_MS;
}

export function requestScheduledReleaseRefresh(
  db: Db,
  now: Date,
  deps: { coordinator?: ReleaseCrawlCoordinator; refresh?: (db: Db, now: Date) => Promise<ReleaseDigest> } = {},
): ReleaseCrawlRequest {
  const coordinator = deps.coordinator ?? releaseCrawlCoordinator;
  const refresh = deps.refresh ?? ((d: Db, n: Date) => refreshReleaseDigest(d, n));
  return coordinator.request(() => refresh(db, now));
}

export function startReleaseWatchScheduler(db: Db): void {
  let lastAttemptAt = 0;
  const tick = async (): Promise<void> => {
    try {
      const now = new Date();
      if (!shouldRefreshReleases(getReleaseWatchConfig(db), getReleaseDigest(db)?.date ?? null, now, lastAttemptAt)) return;
      const request = requestScheduledReleaseRefresh(db, now);
      if (request.status === 'busy') return;
      lastAttemptAt = now.getTime();
      await request.promise;
    } catch (error: unknown) {
      console.warn('[release-watch] daily crawl failed:', error instanceof Error ? error.message : String(error));
    }
  };
  setTimeout(() => { void tick(); }, 40_000).unref?.();
  setInterval(() => { void tick(); }, 60_000).unref?.();
}
