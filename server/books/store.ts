// books / book_new_releases / book_suggestions の DAO。
// SQL はこのファイルだけに置き、 サービス層は Book / NewRelease / Suggestion を扱う。

import type BetterSqlite3 from 'better-sqlite3';
import { normalizeIsbn13, titleKey } from './bib.js';
import type {
  Book, BookCandidate, BookInput, BookRow,
  NewRelease, NewReleaseRow, Suggestion, SuggestionRow, WatchKind,
} from './types.js';

type Db = BetterSqlite3.Database;

function parseJsonArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function toBook(row: BookRow): Book {
  return {
    id: row.id,
    isbn13: row.isbn13,
    asin: row.asin,
    title: row.title,
    authors: parseJsonArray(row.authors_json),
    publisher: row.publisher,
    series: row.series,
    publishedOn: row.published_on,
    rating: row.rating,
    review: row.review,
    tags: parseJsonArray(row.tags_json),
    readOn: row.read_on,
    coverUrl: row.cover_url,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ListBooksOptions {
  /** この評価以上だけ (「良かった本」 の抽出に使う)。 */
  minRating?: number;
  /** タイトル・著者・感想・タグの部分一致。 */
  query?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

export function listBooks(db: Db, options: ListBooksOptions = {}): Book[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.minRating !== undefined) {
    where.push('rating IS NOT NULL AND rating >= ?');
    params.push(options.minRating);
  }
  if (options.query) {
    where.push("(title LIKE ? OR authors_json LIKE ? OR IFNULL(review, '') LIKE ? OR tags_json LIKE ?)");
    const like = `%${options.query}%`;
    params.push(like, like, like, like);
  }
  if (options.tag) {
    where.push('tags_json LIKE ?');
    params.push(`%"${options.tag}"%`);
  }
  const sql = `
    SELECT * FROM books
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY (rating IS NULL), rating DESC, IFNULL(read_on, '') DESC, id DESC
    LIMIT ? OFFSET ?
  `;
  params.push(options.limit ?? 200, options.offset ?? 0);
  return (db.prepare(sql).all(...params) as BookRow[]).map(toBook);
}

export function countBooks(db: Db): { total: number; favorites: number; rated: number } {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) AS favorites,
           SUM(CASE WHEN rating IS NOT NULL THEN 1 ELSE 0 END) AS rated
    FROM books
  `).get() as { total: number; favorites: number | null; rated: number | null };
  return { total: row.total, favorites: row.favorites ?? 0, rated: row.rated ?? 0 };
}

export function getBook(db: Db, id: number): Book | null {
  const row = db.prepare('SELECT * FROM books WHERE id = ?').get(id) as BookRow | undefined;
  return row ? toBook(row) : null;
}

/** ISBN 一致 → それが無ければ title_key 一致で既存行を探す。 */
export function findBook(db: Db, isbn13: string | null, title: string): Book | null {
  if (isbn13) {
    const byIsbn = db.prepare('SELECT * FROM books WHERE isbn13 = ?').get(isbn13) as BookRow | undefined;
    if (byIsbn) return toBook(byIsbn);
  }
  const byTitle = db.prepare('SELECT * FROM books WHERE title_key = ? ORDER BY id LIMIT 1')
    .get(titleKey(title)) as BookRow | undefined;
  return byTitle ? toBook(byTitle) : null;
}

/** 所持判定用の title_key 集合。 サジェスト・新刊の除外に使う。 */
export function ownedTitleKeys(db: Db): Set<string> {
  const rows = db.prepare('SELECT title_key FROM books').all() as { title_key: string }[];
  return new Set(rows.map((r) => r.title_key));
}

export function insertBook(db: Db, input: BookInput, now: Date = new Date()): Book {
  const iso = now.toISOString();
  const isbn = normalizeIsbn13(input.isbn13 ?? null);
  const info = db.prepare(`
    INSERT INTO books (
      isbn13, asin, title, title_key, authors_json, publisher, series, published_on,
      rating, review, tags_json, read_on, cover_url, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    isbn, input.asin ?? null, input.title, titleKey(input.title),
    JSON.stringify(input.authors ?? []), input.publisher ?? null, input.series ?? null,
    input.publishedOn ?? null, input.rating ?? null, input.review ?? null,
    JSON.stringify(input.tags ?? []), input.readOn ?? null, input.coverUrl ?? null,
    input.source ?? 'manual', iso, iso,
  );
  return getBook(db, Number(info.lastInsertRowid)) as Book;
}

const UPDATABLE: Record<string, string> = {
  isbn13: 'isbn13', asin: 'asin', publisher: 'publisher', series: 'series',
  publishedOn: 'published_on', rating: 'rating', review: 'review',
  readOn: 'read_on', coverUrl: 'cover_url', source: 'source',
};

export function updateBook(db: Db, id: number, patch: Partial<BookInput>, now: Date = new Date()): Book | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(UPDATABLE)) {
    if (!(key in patch)) continue;
    sets.push(`${column} = ?`);
    const value = (patch as Record<string, unknown>)[key];
    params.push(key === 'isbn13' ? normalizeIsbn13(value as string | null) : value ?? null);
  }
  if (patch.title !== undefined) {
    sets.push('title = ?', 'title_key = ?');
    params.push(patch.title, titleKey(patch.title));
  }
  if (patch.authors !== undefined) { sets.push('authors_json = ?'); params.push(JSON.stringify(patch.authors)); }
  if (patch.tags !== undefined) { sets.push('tags_json = ?'); params.push(JSON.stringify(patch.tags)); }
  if (sets.length === 0) return getBook(db, id);
  sets.push('updated_at = ?');
  params.push(now.toISOString(), id);
  db.prepare(`UPDATE books SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getBook(db, id);
}

/** 補完候補が得られなかった行を、次回の対象選定では後ろへ回す。 */
export function markBookEnrichmentAttempt(db: Db, id: number, now: Date = new Date()): void {
  db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').run(now.toISOString(), id);
}

export function deleteBook(db: Db, id: number): boolean {
  return db.prepare('DELETE FROM books WHERE id = ?').run(id).changes > 0;
}

// ── 新刊 ────────────────────────────────────────────────────────────

export function toNewRelease(row: NewReleaseRow): NewRelease {
  return {
    id: row.id,
    watchKind: row.watch_kind,
    watchValue: row.watch_value,
    isbn13: row.isbn13,
    title: row.title,
    authors: parseJsonArray(row.authors_json),
    publisher: row.publisher,
    publishedOn: row.published_on,
    url: row.url,
    coverUrl: row.cover_url,
    source: row.source,
    foundAt: row.found_at,
    notifiedAt: row.notified_at,
    dismissedAt: row.dismissed_at,
  };
}

/**
 * 新刊を記録する。 (watch_kind, watch_value, title_key) が既にあれば何もしない
 * ので、 週次巡回を何度回しても通知は 1 回きり。 挿入できたら行を返す。
 */
export function recordNewRelease(
  db: Db,
  watchKind: WatchKind,
  watchValue: string,
  candidate: BookCandidate,
  now: Date = new Date(),
): NewRelease | null {
  const info = db.prepare(`
    INSERT OR IGNORE INTO book_new_releases (
      watch_kind, watch_value, isbn13, title, title_key, authors_json,
      publisher, published_on, url, cover_url, source, found_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    watchKind, watchValue, candidate.isbn13, candidate.title, titleKey(candidate.title),
    JSON.stringify(candidate.authors), candidate.publisher, candidate.publishedOn,
    candidate.url, candidate.coverUrl, candidate.source, now.toISOString(),
  );
  if (info.changes === 0) return null;
  const row = db.prepare('SELECT * FROM book_new_releases WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as NewReleaseRow;
  return toNewRelease(row);
}

export function listNewReleases(db: Db, options: { includeDismissed?: boolean; limit?: number } = {}): NewRelease[] {
  const where = options.includeDismissed ? '' : 'WHERE dismissed_at IS NULL';
  const rows = db.prepare(`
    SELECT * FROM book_new_releases ${where}
    ORDER BY IFNULL(published_on, '') DESC, found_at DESC LIMIT ?
  `).all(options.limit ?? 100) as NewReleaseRow[];
  return rows.map(toNewRelease);
}

/** 未通知の新刊。 Discord 通知スケジューラが拾う。 */
export function listPendingNotifications(db: Db, limit = 20): NewRelease[] {
  const rows = db.prepare(`
    SELECT * FROM book_new_releases
    WHERE notified_at IS NULL AND dismissed_at IS NULL
    ORDER BY found_at ASC LIMIT ?
  `).all(limit) as NewReleaseRow[];
  return rows.map(toNewRelease);
}

export function markNotified(db: Db, ids: number[], now: Date = new Date()): void {
  if (ids.length === 0) return;
  const stmt = db.prepare('UPDATE book_new_releases SET notified_at = ? WHERE id = ?');
  const iso = now.toISOString();
  db.transaction(() => { for (const id of ids) stmt.run(iso, id); })();
}

export function dismissNewRelease(db: Db, id: number, now: Date = new Date()): boolean {
  return db.prepare('UPDATE book_new_releases SET dismissed_at = ? WHERE id = ?')
    .run(now.toISOString(), id).changes > 0;
}

// ── サジェスト ──────────────────────────────────────────────────────

export function toSuggestion(row: SuggestionRow): Suggestion {
  return {
    id: row.id,
    isbn13: row.isbn13,
    title: row.title,
    authors: parseJsonArray(row.authors_json),
    publisher: row.publisher,
    publishedOn: row.published_on,
    url: row.url,
    coverUrl: row.cover_url,
    origin: row.origin,
    reason: row.reason,
    rating: row.rating,
    ratingCount: row.rating_count,
    salesRank: row.sales_rank,
    score: row.score,
    generatedAt: row.generated_at,
    dismissedAt: row.dismissed_at,
  };
}

export interface SuggestionDraft {
  candidate: BookCandidate;
  origin: Suggestion['origin'];
  reason: string;
  score: number;
}

/** 生成のたびに未 dismiss の候補を総入れ替えする (dismiss 済みは履歴として残す)。 */
export function replaceSuggestions(db: Db, drafts: SuggestionDraft[], now: Date = new Date()): Suggestion[] {
  const iso = now.toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM book_suggestions WHERE dismissed_at IS NULL').run();
    const stmt = db.prepare(`
      INSERT INTO book_suggestions (
        isbn13, title, title_key, authors_json, publisher, published_on, url, cover_url,
        origin, reason, rating, rating_count, sales_rank, score, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const draft of drafts) {
      const c = draft.candidate;
      stmt.run(
        c.isbn13, c.title, titleKey(c.title), JSON.stringify(c.authors), c.publisher,
        c.publishedOn, c.url, c.coverUrl, draft.origin, draft.reason,
        c.rating, c.ratingCount, c.salesRank, draft.score, iso,
      );
    }
  })();
  return listSuggestions(db);
}

export function listSuggestions(db: Db, limit = 50): Suggestion[] {
  const rows = db.prepare(`
    SELECT * FROM book_suggestions WHERE dismissed_at IS NULL
    ORDER BY score DESC, id ASC LIMIT ?
  `).all(limit) as SuggestionRow[];
  return rows.map(toSuggestion);
}

/** 「もういい」 を押した候補。 title_key を恒久ブロックに積む。 */
export function dismissSuggestion(db: Db, id: number, now: Date = new Date()): boolean {
  const row = db.prepare('SELECT * FROM book_suggestions WHERE id = ?').get(id) as SuggestionRow | undefined;
  if (!row) return false;
  db.transaction(() => {
    db.prepare('UPDATE book_suggestions SET dismissed_at = ? WHERE id = ?').run(now.toISOString(), id);
    db.prepare(`
      INSERT OR IGNORE INTO book_suggestion_blocks (title_key, title, blocked_at) VALUES (?, ?, ?)
    `).run(row.title_key, row.title, now.toISOString());
  })();
  return true;
}

export function blockedTitleKeys(db: Db): Set<string> {
  const rows = db.prepare('SELECT title_key FROM book_suggestion_blocks').all() as { title_key: string }[];
  return new Set(rows.map((r) => r.title_key));
}
