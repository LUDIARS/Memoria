// 新刊ウォッチ対象の導出。
//
// ウォッチ対象は手で管理しない。 「良かった本」 (rating >= watchMinRating) の
// 著者とシリーズを毎回そこから組み立てる。 評価を下げれば自然に外れる。

import type BetterSqlite3 from 'better-sqlite3';
import { guessSeries } from './bib.js';
import { listBooks } from './store.js';
import type { Book, BooksConfig, WatchTarget } from './types.js';

type Db = BetterSqlite3.Database;

function seriesOf(book: Book): string | null {
  return book.series ?? guessSeries(book.title);
}

/**
 * 良かった本から著者・シリーズを集計して、 冊数の多い順・評価の高い順に並べる。
 * 同じ著者の本が複数あるほど 「追いかけたい著者」 とみなす。
 */
export function deriveWatchTargets(db: Db, config: BooksConfig): WatchTarget[] {
  const favorites = listBooks(db, { minRating: config.watchMinRating, limit: 1_000 });
  const byKey = new Map<string, WatchTarget>();

  const add = (kind: WatchTarget['kind'], value: string, rating: number): void => {
    const trimmed = value.trim();
    if (trimmed.length < 2) return;
    const key = `${kind}:${trimmed}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.bookCount += 1;
      existing.topRating = Math.max(existing.topRating, rating);
      return;
    }
    byKey.set(key, { kind, value: trimmed, bookCount: 1, topRating: rating });
  };

  for (const book of favorites) {
    const rating = book.rating ?? config.watchMinRating;
    for (const author of book.authors) add('author', author, rating);
    const series = seriesOf(book);
    if (series) add('series', series, rating);
  }

  return [...byKey.values()]
    .sort((a, b) => b.bookCount - a.bookCount || b.topRating - a.topRating || a.value.localeCompare(b.value))
    .slice(0, config.maxWatchTargets);
}
