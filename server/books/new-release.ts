// 新刊チェック。 週 1 で 「良かった本」 の著者・シリーズを巡回し、
// 手持ちに無い + 発売日が新しい本だけを book_new_releases に積む。

import type BetterSqlite3 from 'better-sqlite3';
import { dateFloor, titleKey } from './bib.js';
import { effectiveSources } from './config.js';
import { enrichWithOpenBd } from './sources/openbd.js';
import { searchGoogleBooks } from './sources/google-books.js';
import { searchNdl } from './sources/ndl.js';
import { collectResult, type CollectResult } from './sources/http.js';
import { rakutenLatestByAuthor, rakutenLatestBySeries } from './sources/rakuten.js';
import { ownedTitleKeys, recordNewRelease } from './store.js';
import { deriveWatchTargets } from './watch.js';
import type { BookCandidate, BooksConfig, NewRelease, WatchTarget } from './types.js';

type Db = BetterSqlite3.Database;

export interface NewReleaseCheckResult {
  checkedTargets: number;
  found: NewRelease[];
  /** ソース単位の失敗 (巡回自体は続ける)。 */
  errors: string[];
  ranAt: string;
}

function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function shiftDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

/** 1 ウォッチ対象について、 有効な全ソースから候補を集める。 */
interface CandidateFetchResult {
  candidates: BookCandidate[];
  errors: string[];
}

async function fetchCandidatesFor(
  target: WatchTarget,
  config: BooksConfig,
  now: Date,
): Promise<CandidateFetchResult> {
  const sources = effectiveSources(config);
  const from = localDateString(shiftDays(now, -config.newReleaseLookbackDays));
  const jobs: Promise<CollectResult<BookCandidate>>[] = [];

  if (sources.ndl) {
    jobs.push(collectResult('ndl', () => searchNdl(
      target.kind === 'author' ? { creator: target.value, from, limit: 30 } : { title: target.value, from, limit: 30 },
    )));
  }
  if (sources.googleBooks) {
    jobs.push(collectResult('google', () => searchGoogleBooks(
      target.kind === 'author'
        ? { author: target.value, orderBy: 'newest', limit: 20 }
        : { title: target.value, orderBy: 'newest', limit: 20 },
    )));
  }
  if (sources.rakuten) {
    const appId = config.rakutenApplicationId;
    jobs.push(collectResult('rakuten', () => (
      target.kind === 'author'
        ? rakutenLatestByAuthor(appId, target.value, 20)
        : rakutenLatestBySeries(appId, target.value, 20)
    )));
  }

  const results = await Promise.all(jobs);
  const candidates = results.flatMap((result) => result.items);
  const errors = results.flatMap((result) => result.error ? [result.error] : []);
  if (!sources.openbd || candidates.length === 0) return { candidates, errors };

  const enriched = await collectResult('openbd', () => enrichWithOpenBd(candidates));
  return {
    candidates: enriched.error ? candidates : enriched.items,
    errors: enriched.error ? [...errors, enriched.error] : errors,
  };
}

/**
 * 候補を新刊だけに絞る。
 *   - 発売日が [今日 - lookback, 今日 + lookahead] に入る
 *   - 手持ちの本ではない
 *   - 著者ウォッチなら、 その著者名が実際に著者欄に入っている (同名検索のノイズ除け)
 */
export function filterNewReleases(
  candidates: BookCandidate[],
  target: WatchTarget,
  config: BooksConfig,
  owned: Set<string>,
  now: Date,
): BookCandidate[] {
  // 書誌の日付は午前 0 時なので、現在時刻ではなく日単位の境界で比較する。
  const oldest = shiftDays(now, -config.newReleaseLookbackDays);
  const newest = shiftDays(now, config.newReleaseLookaheadDays);
  oldest.setHours(0, 0, 0, 0);
  newest.setHours(0, 0, 0, 0);
  const seen = new Set<string>();
  const out: BookCandidate[] = [];

  for (const candidate of candidates) {
    const published = dateFloor(candidate.publishedOn);
    // 発売日が取れないものは新刊判定できない。 拾うとノイズになるので落とす。
    if (!published) continue;
    if (published < oldest || published > newest) continue;
    const key = titleKey(candidate.title);
    if (!key || owned.has(key) || seen.has(key)) continue;
    if (target.kind === 'author' && !matchesAuthor(candidate, target.value)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out.sort((a, b) => (b.publishedOn ?? '').localeCompare(a.publishedOn ?? ''));
}

/** 表記ゆれ (「山田 太郎」 と 「山田太郎」) を吸収して著者一致を見る。 */
function matchesAuthor(candidate: BookCandidate, author: string): boolean {
  const needle = author.replace(/\s+/g, '');
  return candidate.authors.some((name) => name.replace(/\s+/g, '').includes(needle)
    || needle.includes(name.replace(/\s+/g, '')));
}

/** 全ウォッチ対象を巡回して、 新規に見つかった新刊を保存する。 */
export async function checkNewReleases(
  db: Db,
  config: BooksConfig,
  now: Date = new Date(),
): Promise<NewReleaseCheckResult> {
  const targets = deriveWatchTargets(db, config);
  const owned = ownedTitleKeys(db);
  const found: NewRelease[] = [];
  const errors: string[] = [];

  for (const target of targets) {
    try {
      const fetched = await fetchCandidatesFor(target, config, now);
      errors.push(...fetched.errors.map((error) => `${target.kind} target — ${error}`));
      for (const candidate of filterNewReleases(fetched.candidates, target, config, owned, now)) {
        const saved = recordNewRelease(db, target.kind, target.value, candidate, now);
        if (saved) found.push(saved);
      }
    } catch (error: unknown) {
      errors.push(`${target.kind} target — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { checkedTargets: targets.length, found, errors, ranAt: now.toISOString() };
}
