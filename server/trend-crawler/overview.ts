// 画面と AI 要約に渡す一覧を組み立てる。 ソースごとに最新の成功取得と前回を比べ、 ジャンル順に束ねる。

import type BetterSqlite3 from 'better-sqlite3';
import { findCrossHits, movementOf, rankMap } from './movement.js';
import { firstSeenByKey, lastCrawledAt, latestAttempt, latestOkSnapshots } from './store.js';
import {
  GENRE_LABELS,
  TREND_GENRES,
  type TrendCrawlerConfig,
  type TrendGenreView,
  type TrendOverview,
  type TrendSource,
  type TrendSourceView,
  type TrendSummary,
} from './types.js';

type Db = BetterSqlite3.Database;

export function buildSourceView(db: Db, source: TrendSource): TrendSourceView {
  const [current, previous] = latestOkSnapshots(db, source.id, 2);
  const attempt = latestAttempt(db, source.id);
  // 最新の巡回が失敗していれば、 表示は前回成功分のまま error だけ載せる。
  const error = attempt && !attempt.ok ? attempt.error ?? '取得に失敗しました' : null;
  if (!current) {
    return { sourceId: source.id, name: source.name, kind: source.kind, url: source.url, fetchedAt: null, error, items: [] };
  }
  const previousRanks = previous ? rankMap(previous.items) : null;
  const firstSeen = firstSeenByKey(db, source.id);
  return {
    sourceId: source.id,
    name: source.name,
    kind: source.kind,
    url: source.url,
    fetchedAt: current.fetchedAt,
    error,
    items: current.items.map((item) => ({
      ...item,
      movement: movementOf(item.rank, item.key, previousRanks),
      firstSeenAt: firstSeen.get(item.key) ?? null,
    })),
  };
}

function siteOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

export function buildTrendOverview(db: Db, config: TrendCrawlerConfig, summary: TrendSummary | null): TrendOverview {
  const enabled = config.sources.filter((source) => source.enabled);
  const views = new Map(enabled.map((source) => [source.id, buildSourceView(db, source)]));
  const genres: TrendGenreView[] = TREND_GENRES
    .map((genre) => ({
      genre,
      label: GENRE_LABELS[genre],
      summary: summary?.genres[genre] ?? null,
      sources: enabled.filter((source) => source.genre === genre).map((source) => views.get(source.id)!),
    }))
    .filter((genre) => genre.sources.length > 0);
  const crossHits = findCrossHits(enabled.map((source) => ({
    sourceId: source.id, site: siteOf(source.url), name: source.name, genre: source.genre, items: views.get(source.id)!.items,
  })));
  return { lastCrawledAt: lastCrawledAt(db), summary, crossHits, genres };
}
