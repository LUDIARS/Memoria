// トレンドマップの表示データ。 一覧 (overview) の各ソース上位を 1 枚ずつのタイルにし、 興味の度合い (0〜1) を付ける。

import { normalizeScores, scoreInterest, genreWeight, type ClickStats, type TrendInterestPrefs } from './interest.js';
import { GENRE_LABELS, type TrendGenre, type TrendMovement, type TrendOverview } from './types.js';

/** 1 ソースからマップに載せる件数。 多すぎると小さいタイルが画面を埋める。 */
export const MAP_ITEMS_PER_SOURCE = 8;

export interface TrendMapTile {
  key: string;
  title: string;
  subtitle: string | null;
  url: string | null;
  metric: string | null;
  genre: TrendGenre;
  sourceId: string;
  sourceName: string;
  rank: number;
  movement: TrendMovement;
  /** 0 (興味が薄い) 〜 1 (興味が強い)。 大きさと丸さに使う。 */
  interest: number;
  reasons: string[];
}

export interface TrendMapGenre {
  genre: TrendGenre;
  label: string;
  weight: number;
  count: number;
}

export interface TrendMap {
  lastCrawledAt: string | null;
  prefs: TrendInterestPrefs;
  genres: TrendMapGenre[];
  tiles: TrendMapTile[];
}

export function buildTrendMap(
  overview: TrendOverview,
  prefs: TrendInterestPrefs,
  clicks: ClickStats,
  perSource = MAP_ITEMS_PER_SOURCE,
): TrendMap {
  const crossKeys = new Set(overview.crossHits.map((hit) => hit.key));
  const draft: (Omit<TrendMapTile, 'interest'> & { score: number })[] = [];
  const seen = new Set<string>();
  for (const genre of overview.genres) {
    for (const source of genre.sources) {
      const shown = source.items.slice(0, perSource);
      for (const item of shown) {
        // 同じ話題が複数ソースに出ていても、 マップでは最初の 1 枚にまとめる (色はそのジャンル)。
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        const { score, reasons } = scoreInterest({
          key: item.key,
          title: item.title,
          genre: genre.genre,
          rank: item.rank,
          itemsInSource: shown.length,
          movement: item.movement.status,
          crossHit: crossKeys.has(item.key),
        }, prefs, clicks);
        draft.push({
          key: item.key, title: item.title, subtitle: item.subtitle, url: item.url, metric: item.metric,
          genre: genre.genre, sourceId: source.sourceId, sourceName: source.name, rank: item.rank,
          movement: item.movement, reasons, score,
        });
      }
    }
  }
  const interests = normalizeScores(draft.map((tile) => tile.score));
  const tiles: TrendMapTile[] = draft
    .map(({ score: _score, ...tile }, index) => ({ ...tile, interest: interests[index] }))
    .sort((a, b) => b.interest - a.interest);
  const genres: TrendMapGenre[] = overview.genres.map((genre) => ({
    genre: genre.genre,
    label: GENRE_LABELS[genre.genre],
    weight: genreWeight(prefs, genre.genre),
    count: tiles.filter((tile) => tile.genre === genre.genre).length,
  }));
  return { lastCrawledAt: overview.lastCrawledAt, prefs, genres, tiles };
}
