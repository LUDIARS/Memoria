// 前回の取得と比べた順位の動き、 複数ソースに出ている話題の判定。 DB を知らない純関数だけを置く。

import type { RawTrendItem, TrendCrossHit, TrendGenre, TrendMovement } from './types.js';

/** 比較用キー。 全角/半角・大小文字・空白と記号の差を畳む。 */
export function trendKey(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 200);
}

/**
 * previous が null (このソースの初回取得) なら比べる相手が無いので unknown。
 * 前回に無かった項目は new、 あれば順位差で up / down / same。
 */
export function movementOf(rank: number, key: string, previousRanks: Map<string, number> | null): TrendMovement {
  if (previousRanks === null) return { status: 'unknown', delta: null };
  const before = previousRanks.get(key);
  if (before === undefined) return { status: 'new', delta: null };
  const delta = before - rank;
  if (delta > 0) return { status: 'up', delta };
  if (delta < 0) return { status: 'down', delta };
  return { status: 'same', delta: 0 };
}

/** 同じキーが複数回出たら最上位の順位を採る。 */
export function rankMap(items: Pick<RawTrendItem, 'rank' | 'title'>[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    const key = trendKey(item.title);
    const current = map.get(key);
    if (current === undefined || item.rank < current) map.set(key, item.rank);
  }
  return map;
}

export interface CrossHitInput {
  sourceId: string;
  /** 取得元サイト (ホスト名)。 同じサイトのカテゴリ違い (はてブ総合と暮らし等) の重複は話題の広がりに数えない。 */
  site: string;
  name: string;
  genre: TrendGenre;
  items: Pick<RawTrendItem, 'rank' | 'title'>[];
}

/** 短すぎるキーは別の話題同士が偶然一致しやすいので比べない。 */
const MIN_CROSS_KEY_LENGTH = 2;

/**
 * 2 つ以上の別サイトに同じ話題が出ているものを、 出ているソース数の多い順 → 最高順位の高い順に返す。
 */
export function findCrossHits(inputs: CrossHitInput[], limit = 20): TrendCrossHit[] {
  const byKey = new Map<string, TrendCrossHit>();
  const sitesByKey = new Map<string, Set<string>>();
  for (const input of inputs) {
    const seen = new Set<string>();
    for (const item of input.items) {
      const key = trendKey(item.title);
      if (key.length < MIN_CROSS_KEY_LENGTH || seen.has(key)) continue;
      seen.add(key);
      const hit = byKey.get(key) ?? { key, title: item.title, sources: [] };
      hit.sources.push({ sourceId: input.sourceId, name: input.name, genre: input.genre, rank: item.rank });
      byKey.set(key, hit);
      const sites = sitesByKey.get(key) ?? new Set<string>();
      sites.add(input.site);
      sitesByKey.set(key, sites);
    }
  }
  const bestRank = (hit: TrendCrossHit): number => Math.min(...hit.sources.map((s) => s.rank));
  return [...byKey.values()]
    .filter((hit) => (sitesByKey.get(hit.key)?.size ?? 0) >= 2)
    .sort((a, b) => b.sources.length - a.sources.length || bestRank(a) - bestRank(b))
    .slice(0, limit);
}
