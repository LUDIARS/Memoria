// 巡回の手順: 有効なソースを順に取得して履歴に残す → 古い履歴を消す → AI 要約を作り直す。
// 1 ソースの失敗は他を止めず、 失敗として記録する (画面には前回成功分を出し続ける)。

import type BetterSqlite3 from 'better-sqlite3';
import { getTrendCrawlerConfig, getTrendSummary, setTrendSummary } from './config.js';
import { buildTrendOverview } from './overview.js';
import { fetchTrendSource, type FetchSourceDeps } from './sources/fetch-source.js';
import { CLICK_WINDOW_DAYS, pruneClicksBefore } from './interest-store.js';
import { pruneSnapshotsBefore, recordSnapshot } from './store.js';
import { summarizeTrends, type TrendSummaryRunner } from './summarizer.js';
import type { RawTrendItem, TrendCrawlResult, TrendSource } from './types.js';

type Db = BetterSqlite3.Database;

export type TrendFetcher = (source: TrendSource, limit: number) => Promise<RawTrendItem[]>;

export interface TrendCrawlDeps {
  fetchSource?: TrendFetcher;
  summarize?: TrendSummaryRunner;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 400);
}

export async function crawlTrends(
  db: Db,
  now: Date = new Date(),
  deps: TrendCrawlDeps = {},
  onlySourceId?: string,
): Promise<TrendCrawlResult> {
  const config = getTrendCrawlerConfig(db);
  const fetchSource = deps.fetchSource ?? ((source: TrendSource, limit: number) => fetchTrendSource(source, limit, { now } satisfies FetchSourceDeps));
  const targets = config.sources.filter((source) => source.enabled && (onlySourceId === undefined || source.id === onlySourceId));
  const crawledAt = now.toISOString();
  const failed: TrendCrawlResult['failed'] = [];
  let ok = 0;

  for (const source of targets) {
    try {
      const items = (await fetchSource(source, config.itemsPerSource)).slice(0, config.itemsPerSource);
      if (items.length === 0) throw new Error('一覧が空でした');
      recordSnapshot(db, { sourceId: source.id, genre: source.genre, fetchedAt: crawledAt, ok: true, error: null, items });
      ok += 1;
    } catch (error: unknown) {
      const message = errorMessage(error);
      recordSnapshot(db, { sourceId: source.id, genre: source.genre, fetchedAt: crawledAt, ok: false, error: message, items: [] });
      failed.push({ sourceId: source.id, error: message });
    }
  }

  pruneSnapshotsBefore(db, new Date(now.getTime() - config.retentionDays * DAY_MS).toISOString());
  pruneClicksBefore(db, new Date(now.getTime() - CLICK_WINDOW_DAYS * DAY_MS).toISOString());

  let summaryError: string | null = null;
  // 1 ソースだけの手動更新では要約を作り直さない (全体の傾向は全ソース巡回のときだけ書く)。
  if (config.summarize && onlySourceId === undefined && ok > 0) {
    try {
      const overview = buildTrendOverview(db, config, getTrendSummary(db));
      setTrendSummary(db, await summarizeTrends(overview.genres, now, deps.summarize));
    } catch (error: unknown) {
      summaryError = errorMessage(error);
    }
  }

  return { crawledAt, ok, failed, summaryError };
}
