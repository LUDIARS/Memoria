// トレンドマップの「興味の度合い」を決める純関数。 DB を知らない。
//
// 興味 = 自分で決めた興味 (ジャンルの強さ・気になる言葉) × 自動で学んだ興味 (よく開くジャンル・開いた話題)
//        × トレンドの強さ (順位・新登場・急上昇・複数サイト一致)。
// 表示の大きさは 0〜1 に正規化した値で決め、 最小値でも消さない (大きさの下限は画面側が持つ)。

import { trendKey } from './movement.js';
import type { TrendGenre, TrendMovementStatus } from './types.js';

export interface TrendInterestPrefs {
  /** ジャンルごとの興味の強さ。 0 (ほぼ興味なし) 〜 3。 未設定は 1。 */
  genreWeights: Partial<Record<TrendGenre, number>>;
  /** 気になる言葉。 題名に含まれていると大きくする。 */
  keywords: string[];
}

export const DEFAULT_INTEREST_PREFS: TrendInterestPrefs = { genreWeights: {}, keywords: [] };

export interface ClickStats {
  total: number;
  byGenre: Map<TrendGenre, number>;
  byKey: Map<string, number>;
}

export interface InterestInput {
  key: string;
  title: string;
  genre: TrendGenre;
  rank: number;
  /** そのソースで並んでいる件数 (順位を 0〜1 に直すため)。 */
  itemsInSource: number;
  movement: TrendMovementStatus;
  crossHit: boolean;
}

export interface InterestScore {
  score: number;
  /** 大きくした理由 (画面のツールチップに出す)。 */
  reasons: string[];
}

/** 開いた回数がこれ未満なら、 よく開くジャンルの学習はまだ効かせない。 */
const MIN_CLICKS_FOR_AFFINITY = 3;
/** ジャンルの強さが 0 でも消さないための下限。 */
const MIN_GENRE_WEIGHT = 0.15;

export function genreWeight(prefs: TrendInterestPrefs, genre: TrendGenre): number {
  const value = prefs.genreWeights[genre];
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(3, Math.max(0, value)) : 1;
}

export function matchedKeywords(title: string, keywords: string[]): string[] {
  const key = trendKey(title);
  return keywords.filter((keyword) => {
    const needle = trendKey(keyword);
    return needle.length > 0 && key.includes(needle);
  });
}

/** 順位・動き・複数サイト一致から見たトレンドとしての強さ (およそ 0.5〜1.6)。 */
export function trendStrength(input: InterestInput): number {
  const span = Math.max(1, input.itemsInSource - 1);
  let strength = 1 - 0.5 * Math.min(1, (input.rank - 1) / span);
  if (input.movement === 'new') strength += 0.2;
  if (input.movement === 'up') strength += 0.1;
  if (input.crossHit) strength += 0.3;
  return strength;
}

export function scoreInterest(input: InterestInput, prefs: TrendInterestPrefs, clicks: ClickStats): InterestScore {
  const reasons: string[] = [];
  const weight = genreWeight(prefs, input.genre);
  if (weight !== 1) reasons.push(`ジャンルの興味 ×${weight}`);

  const keywords = matchedKeywords(input.title, prefs.keywords);
  const keywordBoost = 1 + 0.8 * Math.min(2, keywords.length);
  if (keywords.length) reasons.push(`気になる言葉「${keywords.join('」「')}」`);

  let affinity = 1;
  if (clicks.total >= MIN_CLICKS_FOR_AFFINITY) {
    const share = (clicks.byGenre.get(input.genre) ?? 0) / clicks.total;
    affinity = 1 + 1.2 * share;
    if (share >= 0.2) reasons.push('よく開くジャンル');
  }
  const clicked = (clicks.byKey.get(input.key) ?? 0) > 0;
  if (clicked) reasons.push('開いたことがある話題');

  const strength = trendStrength(input);
  if (input.movement === 'new') reasons.push('新登場');
  if (input.crossHit) reasons.push('複数のサイトで話題');

  const score = Math.max(MIN_GENRE_WEIGHT, weight) * keywordBoost * affinity * (clicked ? 1.3 : 1) * strength;
  return { score, reasons };
}

/** スコアを対数で 0〜1 に並べ直す。 全部同じなら真ん中 (0.5)。 */
export function normalizeScores(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const logs = scores.map((score) => Math.log(Math.max(score, 1e-6)));
  const min = Math.min(...logs);
  const max = Math.max(...logs);
  if (max - min < 1e-9) return scores.map(() => 0.5);
  return logs.map((value) => (value - min) / (max - min));
}
