// Discord から本棚を操作する。 スラッシュコマンドの実処理はここに置き、
// slash-commands.ts は引数の取り出しと権限判定だけにする。

import type BetterSqlite3 from 'better-sqlite3';
import {
  booksJobCoordinator, checkNewReleases, countBooks, generateSuggestions,
  getBooksConfig, insertBook, listBooks, listSuggestions,
} from '../../books/index.js';
import { titleKey } from '../../books/bib.js';
import { enrichWithOpenBd } from '../../books/sources/openbd.js';
import { searchGoogleBooks } from '../../books/sources/google-books.js';
import type { Book, NewRelease, Suggestion } from '../../books/index.js';

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
export async function addFavoriteBook(
  db: Db,
  input: { title: string; author?: string | null; rating?: number | null; memo?: string | null },
): Promise<string> {
  const config = getBooksConfig(db);
  let enriched: Awaited<ReturnType<typeof searchGoogleBooks>>[number] | null = null;
  if (config.sources.googleBooks) {
    try {
      const hits = await searchGoogleBooks({
        title: input.title,
        author: input.author || undefined,
        limit: 3,
      });
      const withCovers = config.sources.openbd ? await enrichWithOpenBd(hits) : hits;
      const wanted = titleKey(input.title);
      enriched = withCovers.find((candidate) => {
        const candidateKey = titleKey(candidate.title);
        return wanted.length > 0 && candidateKey.length > 0
          && (candidateKey === wanted || candidateKey.startsWith(wanted) || wanted.startsWith(candidateKey));
      }) ?? null;
    } catch {
      // 書誌が引けなくても登録は続ける。
    }
  }

  const book = insertBook(db, {
    title: enriched?.title ?? input.title,
    authors: input.author ? [input.author] : enriched?.authors ?? [],
    isbn13: enriched?.isbn13 ?? null,
    publisher: enriched?.publisher ?? null,
    series: enriched?.series ?? null,
    publishedOn: enriched?.publishedOn ?? null,
    coverUrl: enriched?.coverUrl ?? null,
    rating: input.rating ?? null,
    review: input.memo ?? null,
    source: enriched ? 'google_books' : 'manual',
  });

  const watched = book.rating !== null && book.rating >= config.watchMinRating;
  const authors = book.authors.length > 0 ? ` / ${book.authors.join(', ')}` : '';
  return [
    `📚 登録しました — **${book.title}**${authors} ${starText(book.rating)}`,
    watched
      ? 'この著者・シリーズは新刊チェックの対象になりました。'
      : `★${config.watchMinRating} 以上を付けると新刊チェックの対象になります。`,
  ].join('\n');
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
