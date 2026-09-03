// 既存行の書誌補完。
//
// 登録時に Google Books が 429 だったりすると、 タイトルだけの行が残る。
// そのままだと著者ウォッチもサジェストも効かないので、 後から埋め直す口を用意する。
//
// 埋めるのは**空いている欄だけ**。 評価・感想・読了日・タイトルは本人のものなので触らない。

import type BetterSqlite3 from 'better-sqlite3';
import { lookupBibliography, pickBestMatch, type LookupDeps } from './lookup.js';
import { getBook, listBooks, markBookEnrichmentAttempt, updateBook } from './store.js';
import type { Book, BookInput, BooksConfig } from './types.js';

type Db = BetterSqlite3.Database;

export interface EnrichResult {
  id: number;
  title: string;
  /** 実際に埋まった項目名 (空なら変化なし)。 */
  filled: string[];
  warning: string | null;
}

/** 書誌が欠けている行か (著者も ISBN も無い = ウォッチにもサジェストにも使えない)。 */
export function needsEnrichment(book: Book): boolean {
  return book.authors.length === 0 && book.isbn13 === null;
}

export async function enrichBook(
  db: Db,
  id: number,
  config: BooksConfig,
  deps: LookupDeps = {},
): Promise<EnrichResult | null> {
  const book = getBook(db, id);
  if (!book) return null;

  const result = await lookupBibliography(config, {
    title: book.title,
    author: book.authors[0],
  }, deps);
  // 部分一致の別の本で埋めない。 一致するものが無ければ何もしない。
  const candidate = pickBestMatch(result.candidates, book.title);
  const current = getBook(db, id);
  if (!current) return null;
  // 照会中にタイトルが編集された場合、古いタイトル用の候補は適用しない。
  if (current.title !== book.title || !candidate) {
    if (needsEnrichment(current)) markBookEnrichmentAttempt(db, id);
    return { id, title: current.title, filled: [], warning: result.warning };
  }

  const patch: Partial<BookInput> = {};
  const filled: string[] = [];
  // 外部 I/O 後の最新行を基準にする。照会中の手編集を上書きしないため。
  if (current.authors.length === 0 && candidate.authors.length > 0) {
    patch.authors = candidate.authors;
    filled.push('著者');
  }
  if (current.isbn13 === null && candidate.isbn13) { patch.isbn13 = candidate.isbn13; filled.push('ISBN'); }
  if (current.publisher === null && candidate.publisher) { patch.publisher = candidate.publisher; filled.push('出版社'); }
  if (current.series === null && candidate.series) { patch.series = candidate.series; filled.push('シリーズ'); }
  if (current.publishedOn === null && candidate.publishedOn) { patch.publishedOn = candidate.publishedOn; filled.push('発売日'); }
  if (current.coverUrl === null && candidate.coverUrl) { patch.coverUrl = candidate.coverUrl; filled.push('書影'); }
  if (filled.length > 0 && candidate.source === 'llm_inferred') patch.source = 'llm_inferred';

  if (filled.length > 0) updateBook(db, id, patch);
  else if (needsEnrichment(current)) markBookEnrichmentAttempt(db, id);
  return { id, title: current.title, filled, warning: result.warning };
}

export interface EnrichMissingResult {
  targets: number;
  results: EnrichResult[];
}

/**
 * 書誌が欠けている行をまとめて補完する。 外部 API を叩くので既定 20 件まで。
 * 1 冊の失敗で全体を止めない (残りは次回に回る)。
 */
export async function enrichMissingBooks(
  db: Db,
  config: BooksConfig,
  limit = 20,
  deps: LookupDeps = {},
): Promise<EnrichMissingResult> {
  // 未成功の古い試行から選び、失敗行は updatedAt を進めて後続を飢餓させない。
  const targets = listBooks(db, { limit: 1_000 })
    .filter(needsEnrichment)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id - b.id)
    .slice(0, limit);
  const results: EnrichResult[] = [];
  for (const book of targets) {
    try {
      const result = await enrichBook(db, book.id, config, deps);
      if (result) results.push(result);
    } catch {
      markBookEnrichmentAttempt(db, book.id);
      results.push({
        id: book.id,
        title: book.title,
        filled: [],
        // 外部応答・URL・ローカル設定を API レスポンスへ反射しない。
        warning: '書誌補完に失敗しました',
      });
    }
  }
  return { targets: targets.length, results };
}
