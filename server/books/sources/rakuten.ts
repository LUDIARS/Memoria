// 楽天ブックス書籍検索 API。 アプリ ID (applicationId) が要る代わりに
// 「売れ筋順」 が取れる唯一のソースなので、 人気サジェストの実データ軸に使う。
// https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404

import { cleanAuthors, normalizeDate, normalizeIsbn13 } from '../bib.js';
import type { BookCandidate } from '../types.js';
import { fetchJson } from './http.js';

const ENDPOINT = 'https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404';

interface RakutenItem {
  Item?: {
    title?: string;
    subTitle?: string;
    seriesName?: string;
    author?: string;
    publisherName?: string;
    salesDate?: string;
    isbn?: string;
    itemUrl?: string;
    largeImageUrl?: string;
    mediumImageUrl?: string;
    reviewAverage?: string;
    reviewCount?: number;
  };
}

function toCandidate(entry: RakutenItem, index: number, ranked: boolean): BookCandidate | null {
  const item = entry.Item;
  if (!item?.title) return null;
  const title = item.subTitle ? `${item.title} ${item.subTitle}` : item.title;
  const average = item.reviewAverage ? Number(item.reviewAverage) : NaN;
  return {
    isbn13: normalizeIsbn13(item.isbn ?? null),
    title,
    authors: cleanAuthors((item.author ?? '').split(/[/／,，]/)),
    publisher: item.publisherName || null,
    series: item.seriesName || null,
    publishedOn: normalizeDate(item.salesDate ?? null),
    // 楽天の画像 URL は `?_ex=200x200` のサイズ指定付き。 そのまま使える。
    coverUrl: item.largeImageUrl || item.mediumImageUrl || null,
    url: item.itemUrl || null,
    source: 'rakuten',
    rating: Number.isFinite(average) && average > 0 ? average : null,
    ratingCount: typeof item.reviewCount === 'number' ? item.reviewCount : null,
    salesRank: ranked ? index + 1 : null,
  };
}

export interface RakutenQuery {
  applicationId: string;
  author?: string;
  title?: string;
  keyword?: string;
  booksGenreId?: string;
  /** 'sales' = 売れ筋順 (ランキング)、 '-releaseDate' = 発売日の新しい順。 */
  sort?: 'sales' | '-releaseDate' | 'standard';
  limit?: number;
}

export async function searchRakutenBooks(query: RakutenQuery): Promise<BookCandidate[]> {
  if (!query.applicationId) return [];
  if (!query.author && !query.title && !query.keyword && !query.booksGenreId) return [];
  const url = new URL(ENDPOINT);
  url.searchParams.set('format', 'json');
  url.searchParams.set('applicationId', query.applicationId);
  url.searchParams.set('hits', String(Math.min(query.limit ?? 20, 30)));
  const sort = query.sort ?? 'standard';
  url.searchParams.set('sort', sort);
  if (query.author) url.searchParams.set('author', query.author);
  if (query.title) url.searchParams.set('title', query.title);
  if (query.keyword) url.searchParams.set('keyword', query.keyword);
  if (query.booksGenreId) url.searchParams.set('booksGenreId', query.booksGenreId);
  const body = await fetchJson<{ Items?: RakutenItem[] }>(url.toString());
  const ranked = sort === 'sales';
  return (body.Items ?? [])
    .map((entry, index) => toCandidate(entry, index, ranked))
    .filter((c): c is BookCandidate => c !== null);
}

/** 著者の売れ筋。 「この著者の人気作でまだ読んでいないもの」 を出すのに使う。 */
export function rakutenPopularByAuthor(applicationId: string, author: string, limit = 10): Promise<BookCandidate[]> {
  return searchRakutenBooks({ applicationId, author, sort: 'sales', limit });
}

/** キーワード (タグ・ジャンル語) の売れ筋。 */
export function rakutenPopularByKeyword(applicationId: string, keyword: string, limit = 10): Promise<BookCandidate[]> {
  return searchRakutenBooks({ applicationId, keyword, sort: 'sales', limit });
}

/** 著者の最新刊 (発売日降順)。 新刊チェックで使う。 */
export function rakutenLatestByAuthor(applicationId: string, author: string, limit = 10): Promise<BookCandidate[]> {
  return searchRakutenBooks({ applicationId, author, sort: '-releaseDate', limit });
}

/** シリーズ名の最新刊。 楽天は seriesName で引けないので title 部分一致で代用する。 */
export function rakutenLatestBySeries(applicationId: string, series: string, limit = 10): Promise<BookCandidate[]> {
  return searchRakutenBooks({ applicationId, title: series, sort: '-releaseDate', limit });
}
