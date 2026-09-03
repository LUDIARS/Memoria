// 人気の本サジェスト。 neco 指定の 3 系統をマージする。
//   llm             — 良かった本の傾向から LLM が提案 → 書誌 API で実在確認
//   rakuten_ranking — 好きな著者・タグの楽天売れ筋 (実売ベース)
//   google_rating   — 好きな著者の Google Books 高評価作
//
// 生成のたびに未 dismiss 候補を総入れ替えする。

import type BetterSqlite3 from 'better-sqlite3';
import { runLlm } from '../llm.js';
import { titleKey } from './bib.js';
import { effectiveSources } from './config.js';
import { searchGoogleBooks } from './sources/google-books.js';
import { collectResult, safeCollect, type CollectResult } from './sources/http.js';
import { searchNdl } from './sources/ndl.js';
import { enrichWithOpenBd } from './sources/openbd.js';
import { rakutenPopularByAuthor, rakutenPopularByKeyword } from './sources/rakuten.js';
import { buildSuggestPrompt, parseSuggestOutput, type LlmBookProposal } from './suggest-prompt.js';
import {
  blockedTitleKeys, listBooks, listSuggestions, ownedTitleKeys, replaceSuggestions, type SuggestionDraft,
} from './store.js';
import type { BookCandidate, BooksConfig, Suggestion, SuggestionOrigin } from './types.js';

type Db = BetterSqlite3.Database;

const ORIGIN_WEIGHT: Record<SuggestionOrigin, number> = {
  llm: 1.0,
  rakuten_ranking: 0.8,
  google_rating: 0.6,
};

/** 好きな著者・タグをいくつまで外部ソースに当てるか (API 呼び出し数の上限)。 */
const MAX_SEED_AUTHORS = 5;
const MAX_SEED_KEYWORDS = 3;
const MIN_GOOGLE_RATING = 4.0;
const MIN_GOOGLE_RATING_COUNT = 10;

export type LlmRunner = (prompt: string) => Promise<string>;

export interface SuggestDeps {
  runLlm?: LlmRunner;
}

const defaultRunner: LlmRunner = (prompt) => runLlm({ task: 'book_suggest', prompt, timeoutMs: 240_000 });

function throwIfAllAttemptsFailed<T>(attempts: CollectResult<T>[], message: string): void {
  if (attempts.length > 0 && attempts.every((attempt) => attempt.error !== null)) throw new Error(message);
}

/** 候補の質を 0〜0.3 の加点にする。 評価と売れ筋順位のどちらか強い方を採る。 */
function qualityBonus(candidate: BookCandidate): number {
  const byRating = candidate.rating !== null
    ? Math.max(0, Math.min(0.3, ((candidate.rating - 3) / 2) * 0.3))
    : 0;
  const byRank = candidate.salesRank !== null
    ? Math.max(0, Math.min(0.3, (1 - (candidate.salesRank - 1) / 20) * 0.3))
    : 0;
  return Math.max(byRating, byRank);
}

function scoreFor(origin: SuggestionOrigin, candidate: BookCandidate): number {
  return ORIGIN_WEIGHT[origin] + qualityBonus(candidate);
}

/** LLM が挙げた 1 冊を書誌 API で照合する。 見つからなければ null (架空タイトル除け)。 */
export async function verifyProposal(
  proposal: LlmBookProposal,
  config: BooksConfig,
): Promise<BookCandidate | null> {
  const sources = effectiveSources(config);
  const wanted = titleKey(proposal.title);
  if (!wanted) return null;
  const attempts: CollectResult<BookCandidate>[] = [];

  if (sources.googleBooks) {
    const result = await collectResult('google-verify', () => searchGoogleBooks({
      title: proposal.title,
      author: proposal.author || undefined,
      limit: 5,
    }));
    attempts.push(result);
    const hits = result.items;
    const exact = hits.find((hit) => titleKey(hit.title) === wanted);
    if (exact) return exact;
    // 副題の付き外れでキーがずれることがあるので、 前方一致まで許す。
    const partial = hits.find((hit) => {
      const hitKey = titleKey(hit.title);
      return hitKey.length > 0 && (hitKey.startsWith(wanted) || wanted.startsWith(hitKey));
    });
    if (partial) return partial;
  }

  if (sources.ndl) {
    const result = await collectResult('ndl-verify', () => searchNdl({ title: proposal.title, limit: 5 }));
    attempts.push(result);
    const hits = result.items;
    const exact = hits.find((hit) => titleKey(hit.title) === wanted);
    if (exact) return exact;
  }

  throwIfAllAttemptsFailed(attempts, 'all verification sources failed');
  return null;
}

async function collectLlmSuggestions(
  db: Db,
  config: BooksConfig,
  deps: SuggestDeps,
): Promise<SuggestionDraft[]> {
  const sources = effectiveSources(config);
  if (!sources.googleBooks && !sources.ndl) return [];
  const favorites = listBooks(db, { minRating: config.watchMinRating, limit: 200 });
  const read = listBooks(db, { limit: 200 });
  const runner = deps.runLlm ?? defaultRunner;
  const raw = await runner(buildSuggestPrompt(favorites, read, config.suggestionCount));
  const proposals = parseSuggestOutput(raw);

  const drafts: SuggestionDraft[] = [];
  for (const proposal of proposals) {
    const candidate = await verifyProposal(proposal, config);
    if (!candidate) continue;
    drafts.push({
      candidate,
      origin: 'llm',
      reason: proposal.reason || 'あなたの好みの傾向から',
      score: scoreFor('llm', candidate),
    });
  }
  return drafts;
}

/** 良かった本から、 外部ソースに当てる著者・キーワードの種を作る。 */
function seedsFrom(db: Db, config: BooksConfig): { authors: string[]; keywords: string[] } {
  const favorites = listBooks(db, { minRating: config.watchMinRating, limit: 200 });
  const authorCount = new Map<string, number>();
  const tagCount = new Map<string, number>();
  for (const book of favorites) {
    for (const author of book.authors) authorCount.set(author, (authorCount.get(author) ?? 0) + 1);
    for (const tag of book.tags) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
  }
  const top = (map: Map<string, number>, limit: number): string[] => [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
  return { authors: top(authorCount, MAX_SEED_AUTHORS), keywords: top(tagCount, MAX_SEED_KEYWORDS) };
}

async function collectRakutenSuggestions(db: Db, config: BooksConfig): Promise<SuggestionDraft[]> {
  if (!effectiveSources(config).rakuten) return [];
  const appId = config.rakutenApplicationId;
  const { authors, keywords } = seedsFrom(db, config);
  const drafts: SuggestionDraft[] = [];
  const attempts: CollectResult<BookCandidate>[] = [];

  for (const author of authors) {
    const result = await collectResult('rakuten-popular', () => rakutenPopularByAuthor(appId, author, 10));
    attempts.push(result);
    for (const candidate of result.items) {
      drafts.push({
        candidate,
        origin: 'rakuten_ranking',
        reason: `${author} の楽天売れ筋 ${candidate.salesRank ?? '-'} 位`,
        score: scoreFor('rakuten_ranking', candidate),
      });
    }
  }
  for (const keyword of keywords) {
    const result = await collectResult('rakuten-keyword', () => rakutenPopularByKeyword(appId, keyword, 10));
    attempts.push(result);
    for (const candidate of result.items) {
      drafts.push({
        candidate,
        origin: 'rakuten_ranking',
        reason: `「${keyword}」 の楽天売れ筋 ${candidate.salesRank ?? '-'} 位`,
        score: scoreFor('rakuten_ranking', candidate),
      });
    }
  }
  throwIfAllAttemptsFailed(attempts, 'all Rakuten suggestion requests failed');
  return drafts;
}

async function collectGoogleRatingSuggestions(db: Db, config: BooksConfig): Promise<SuggestionDraft[]> {
  if (!effectiveSources(config).googleBooks) return [];
  const { authors } = seedsFrom(db, config);
  const drafts: SuggestionDraft[] = [];
  const attempts: CollectResult<BookCandidate>[] = [];
  for (const author of authors) {
    const result = await collectResult('google-popular', () => searchGoogleBooks({ author, limit: 20 }));
    attempts.push(result);
    for (const candidate of result.items) {
      if (candidate.rating === null || candidate.rating < MIN_GOOGLE_RATING) continue;
      if ((candidate.ratingCount ?? 0) < MIN_GOOGLE_RATING_COUNT) continue;
      drafts.push({
        candidate,
        origin: 'google_rating',
        reason: `${author} の高評価作 (★${candidate.rating.toFixed(1)} / ${candidate.ratingCount} 件)`,
        score: scoreFor('google_rating', candidate),
      });
    }
  }
  throwIfAllAttemptsFailed(attempts, 'all Google suggestion requests failed');
  return drafts;
}

/** 所持済み・ブロック済み・重複を落として上位だけ残す。 同じ本は最高スコアの根拠を採る。 */
export function mergeDrafts(
  drafts: SuggestionDraft[],
  owned: Set<string>,
  blocked: Set<string>,
  limit: number,
): SuggestionDraft[] {
  const best = new Map<string, SuggestionDraft>();
  for (const draft of drafts) {
    const key = titleKey(draft.candidate.title);
    if (!key || owned.has(key) || blocked.has(key)) continue;
    const existing = best.get(key);
    if (!existing || draft.score > existing.score) best.set(key, draft);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface SuggestResult {
  suggestions: Suggestion[];
  generatedAt: string;
  /** 系統単位の失敗。 失敗時は直前の候補を保つ。 */
  errors: string[];
  /** 系統ごとの採用件数 (画面と Discord で内訳を出す)。 */
  byOrigin: Record<SuggestionOrigin, number>;
}

export async function generateSuggestions(
  db: Db,
  config: BooksConfig,
  now: Date = new Date(),
  deps: SuggestDeps = {},
): Promise<SuggestResult> {
  const [llm, rakuten, google] = await Promise.all([
    collectResult('llm-suggest', () => collectLlmSuggestions(db, config, deps)),
    collectResult('rakuten-suggest', () => collectRakutenSuggestions(db, config)),
    collectResult('google-suggest', () => collectGoogleRatingSuggestions(db, config)),
  ]);
  const errors = [llm.error, rakuten.error, google.error].filter((error): error is string => error !== null);

  const merged = mergeDrafts(
    [...llm.items, ...rakuten.items, ...google.items],
    ownedTitleKeys(db),
    blockedTitleKeys(db),
    config.suggestionCount,
  );

  const enriched = effectiveSources(config).openbd
    ? await withOpenBdCovers(merged)
    : merged;

  // 一時障害で全系統が空になったときは、最後の正常な候補を消さない。
  const suggestions = errors.length > 0 && enriched.length === 0
    ? listSuggestions(db)
    : replaceSuggestions(db, enriched, now);
  const byOrigin: Record<SuggestionOrigin, number> = { llm: 0, rakuten_ranking: 0, google_rating: 0 };
  for (const draft of enriched) byOrigin[draft.origin] += 1;
  return { suggestions, generatedAt: now.toISOString(), errors, byOrigin };
}

/** 書影を openBD で補う。 失敗しても候補はそのまま返す。 */
async function withOpenBdCovers(drafts: SuggestionDraft[]): Promise<SuggestionDraft[]> {
  const enriched = await safeCollect('openbd-suggest', () => enrichWithOpenBd(drafts.map((d) => d.candidate)));
  if (enriched.length !== drafts.length) return drafts;
  return drafts.map((draft, index) => ({ ...draft, candidate: enriched[index] }));
}
