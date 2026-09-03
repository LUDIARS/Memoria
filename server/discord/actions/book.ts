// Discord から本棚を操作する。 スラッシュコマンドの実処理はここに置き、
// slash-commands.ts は引数の取り出しと権限判定だけにする。

import type BetterSqlite3 from 'better-sqlite3';
import {
  booksJobCoordinator, checkNewReleases, countBooks, generateSuggestions,
  getBooksConfig, insertBook, listBooks, listSuggestions, updateBook,
} from '../../books/index.js';
import { lookupBibliography, pickBestMatch } from '../../books/lookup.js';
import type { Book, BookCandidate, NewRelease, Suggestion } from '../../books/index.js';

type Db = BetterSqlite3.Database;

const MAX_LINES = 20;

function httpLink(raw: string | null): string {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
    return isHttp && !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

function starText(rating: number | null): string {
  return rating ? '★'.repeat(rating) : '—';
}

function bookLine(book: Book): string {
  const authors = book.authors.length > 0 ? ` / ${book.authors.join(', ')}` : '';
  const read = book.readOn ? ` (${book.readOn} 読了)` : '';
  return `・${starText(book.rating)} ${book.title}${authors}${read}`;
}

/**
 * 良かった本を 1 冊登録する。 タイトルだけ渡せば書誌 API で著者・出版社・書影を補う。
 * 見つからなければタイトルだけで登録する (登録を落とさないほうが大事)。
 */
export interface AddedBook {
  book: Book;
  message: string;
  /** 評価が未設定なら true。 Discord 側は★ボタンを出す。 */
  needsRating: boolean;
}

/**
 * 良かった本を 1 冊登録する。 タイトルだけ渡せば書誌を引いて著者・ISBN・書影を補う。
 * 書誌が引けなくてもタイトルだけで登録する (登録を落とさないほうが大事)。
 */
export async function addFavoriteBook(
  db: Db,
  input: { title: string; author?: string | null; rating?: number | null; memo?: string | null },
): Promise<AddedBook> {
  const config = getBooksConfig(db);
  let found: BookCandidate | null = null;
  let warning: string | null = null;
  try {
    // Google Books → NDL → AI 補完 まで面倒を見るのは lookup 側。 ここは結果を選ぶだけ。
    const result = await lookupBibliography(config, { title: input.title, author: input.author || undefined });
    warning = result.warning;
    found = pickBestMatch(result.candidates, input.title);
  } catch {
    // 書誌が引けなくても登録は続ける。
  }

  const book = insertBook(db, {
    title: found?.title ?? input.title,
    authors: input.author ? [input.author] : found?.authors ?? [],
    isbn13: found?.isbn13 ?? null,
    publisher: found?.publisher ?? null,
    series: found?.series ?? null,
    publishedOn: found?.publishedOn ?? null,
    coverUrl: found?.coverUrl ?? null,
    rating: input.rating ?? null,
    review: input.memo ?? null,
    source: found?.source ?? 'manual',
  });

  const authors = book.authors.length > 0 ? ` / ${book.authors.join(', ')}` : '';
  const lines = [`📚 登録しました — **${book.title}**${authors}`];
  if (book.isbn13) lines.push(`ISBN ${book.isbn13}${book.publisher ? ` · ${book.publisher}` : ''}`);
  if (found?.source === 'llm_inferred') lines.push('(書誌 API が引けなかったため AI の推定で補いました)');
  else if (warning) lines.push(`(${warning})`);
  lines.push(ratingLine(book, config.watchMinRating));

  return { book, message: lines.join('\n'), needsRating: book.rating === null };
}

/** 評価と、 それがウォッチ対象になるかどうかの一言。 */
export function ratingLine(book: Book, watchMinRating: number): string {
  if (book.rating === null) return `評価は？ ★${watchMinRating} 以上で新刊チェックの対象になります。`;
  return book.rating >= watchMinRating
    ? `${starText(book.rating)} — この著者・シリーズは新刊チェックの対象になりました。`
    : `${starText(book.rating)} — 新刊チェックの対象は★${watchMinRating} 以上です。`;
}

/** ★ボタンから評価を後付けする。 対象が無ければ null。 */
export function rateBook(db: Db, id: number, rating: number | null): { book: Book; message: string } | null {
  const config = getBooksConfig(db);
  const book = updateBook(db, id, { rating });
  if (!book) return null;
  const authors = book.authors.length > 0 ? ` / ${book.authors.join(', ')}` : '';
  return {
    book,
    message: [`📚 **${book.title}**${authors}`, ratingLine(book, config.watchMinRating)].join('\n'),
  };
}

/** 蔵書一覧。 query 無しならお気に入り (★watchMinRating 以上)。 */
export function listBooksMessage(db: Db, query?: string | null): string {
  const config = getBooksConfig(db);
  const books = query
    ? listBooks(db, { query, limit: 100 })
    : listBooks(db, { minRating: config.watchMinRating, limit: 100 });
  const label = query ? `"${query}" の検索結果` : `お気に入り (★${config.watchMinRating} 以上)`;
  if (books.length === 0) return `(${label} — 該当なし)`;

  const counts = countBooks(db);
  const lines = [`**📚 Memoria 本棚 — ${label}**`, ''];
  for (const book of books.slice(0, MAX_LINES)) lines.push(bookLine(book));
  if (books.length > MAX_LINES) lines.push(`…他 ${books.length - MAX_LINES} 件`);
  lines.push('', `${books.length} 件 / 蔵書 ${counts.total} 冊 (お気に入り ${counts.favorites} 冊)`);
  return lines.join('\n').slice(0, 1900);
}

export function formatNewReleases(releases: NewRelease[], heading = '📚 新刊が出ています'): string {
  const lines = [`**${heading}**`, ''];
  for (const release of releases.slice(0, MAX_LINES)) {
    const authors = release.authors.length > 0 ? ` / ${release.authors.join(', ')}` : '';
    const published = release.publishedOn ? ` — ${release.publishedOn} 発売` : '';
    const safeUrl = httpLink(release.url);
    const url = safeUrl ? `\n  ${safeUrl}` : '';
    lines.push(`・**${release.title}**${authors}${published}  〔${release.watchValue}〕${url}`);
  }
  if (releases.length > MAX_LINES) lines.push(`…他 ${releases.length - MAX_LINES} 件`);
  return lines.join('\n').slice(0, 1900);
}

/** 新刊チェックを今すぐ回す。 */
export async function runNewReleaseCheck(db: Db): Promise<string> {
  const request = booksJobCoordinator.request('new_release', () => checkNewReleases(db, getBooksConfig(db)));
  if (request.status === 'busy') return '新刊チェックはすでに実行中です。';
  const result = await request.promise;
  if (result.checkedTargets === 0) {
    return 'ウォッチ対象がありません。 まず `/book` で良かった本を登録してください。';
  }
  if (result.errors.length > 0) {
    return `書誌ソースの取得に失敗しました (${result.errors.length} 件)。時間を置いて再試行してください。`;
  }
  if (result.found.length === 0) {
    return `新刊はありませんでした (${result.checkedTargets} 対象を確認)。`;
  }
  return formatNewReleases(result.found, `📚 新刊 ${result.found.length} 件`);
}

function suggestionLine(suggestion: Suggestion): string {
  const authors = suggestion.authors.length > 0 ? ` / ${suggestion.authors.join(', ')}` : '';
  const safeUrl = httpLink(suggestion.url);
  const url = safeUrl ? `\n  ${safeUrl}` : '';
  return `・**${suggestion.title}**${authors}\n  ${suggestion.reason}${url}`;
}

export function formatSuggestions(suggestions: Suggestion[]): string {
  if (suggestions.length === 0) return 'サジェスト候補がありません。';
  const lines = ['**📖 読んでみては**', ''];
  for (const suggestion of suggestions.slice(0, 10)) lines.push(suggestionLine(suggestion));
  return lines.join('\n').slice(0, 1900);
}

/** サジェストを再生成して返す。 */
export async function runSuggest(db: Db): Promise<string> {
  const request = booksJobCoordinator.request('suggest', () => generateSuggestions(db, getBooksConfig(db)));
  if (request.status === 'busy') return 'サジェスト生成はすでに実行中です。';
  const result = await request.promise;
  if (result.errors.length > 0 && result.suggestions.length === 0) {
    return 'サジェストの取得に失敗しました。候補は変更していません。';
  }
  const breakdown = `LLM ${result.byOrigin.llm} / 楽天売れ筋 ${result.byOrigin.rakuten_ranking} / Google 高評価 ${result.byOrigin.google_rating}`;
  const warning = result.errors.length > 0 ? ` / 一部取得失敗 ${result.errors.length} 件` : '';
  return `${formatSuggestions(result.suggestions)}\n\n(内訳: ${breakdown}${warning})`;
}

/** 生成済みのサジェストをそのまま見る (LLM を回さない)。 */
export function showSuggestions(db: Db): string {
  return formatSuggestions(listSuggestions(db, 10));
}
