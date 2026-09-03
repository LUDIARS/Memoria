// Google Books API (キー不要)。 洋書に強く、 平均評価 (averageRating) が取れる
// 唯一のソースなので 「人気の本サジェスト」 の評価軸として使う。
// https://www.googleapis.com/books/v1/volumes?q=...

import { cleanAuthors, normalizeDate, normalizeIsbn13 } from '../bib.js';
import type { BookCandidate } from '../types.js';
import { fetchJson } from './http.js';

const ENDPOINT = 'https://www.googleapis.com/books/v1/volumes';

interface GoogleVolume {
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    industryIdentifiers?: { type?: string; identifier?: string }[];
    imageLinks?: { thumbnail?: string; smallThumbnail?: string };
    averageRating?: number;
    ratingsCount?: number;
    infoLink?: string;
  };
}

function toCandidate(volume: GoogleVolume): BookCandidate | null {
  const info = volume.volumeInfo;
  if (!info?.title) return null;
  const isbn = (info.industryIdentifiers ?? [])
    .map((id) => normalizeIsbn13(id.identifier ?? null))
    .find((value): value is string => value !== null) ?? null;
  // thumbnail は http で返ることがあるので https に寄せる (混在コンテンツ回避)。
  const cover = (info.imageLinks?.thumbnail ?? info.imageLinks?.smallThumbnail ?? null)?.replace(/^http:/, 'https:') ?? null;
  return {
    isbn13: isbn,
    title: info.subtitle ? `${info.title} ${info.subtitle}` : info.title,
    authors: cleanAuthors(info.authors ?? []),
    publisher: info.publisher ?? null,
    series: null,
    publishedOn: normalizeDate(info.publishedDate ?? null),
    coverUrl: cover,
    url: info.infoLink ?? null,
    source: 'google_books',
    rating: typeof info.averageRating === 'number' ? info.averageRating : null,
    ratingCount: typeof info.ratingsCount === 'number' ? info.ratingsCount : null,
    salesRank: null,
  };
}

export interface GoogleBooksQuery {
  author?: string;
  title?: string;
  isbn?: string;
  freeText?: string;
  limit?: number;
  /** 発売日順にしたいときだけ 'newest' (既定は関連度順)。 */
  orderBy?: 'relevance' | 'newest';
}

function buildQuery(query: GoogleBooksQuery): string {
  const terms: string[] = [];
  if (query.isbn) terms.push(`isbn:${query.isbn}`);
  if (query.author) terms.push(`inauthor:"${query.author}"`);
  if (query.title) terms.push(`intitle:"${query.title}"`);
  if (query.freeText) terms.push(query.freeText);
  return terms.join(' ');
}

export async function searchGoogleBooks(query: GoogleBooksQuery): Promise<BookCandidate[]> {
  const q = buildQuery(query);
  if (!q.trim()) return [];
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', q);
  url.searchParams.set('maxResults', String(Math.min(query.limit ?? 20, 40)));
  url.searchParams.set('orderBy', query.orderBy ?? 'relevance');
  url.searchParams.set('printType', 'books');
  // country を付けないと地域判定に失敗して 403 になることがある。
  url.searchParams.set('country', 'JP');
  const body = await fetchJson<{ items?: GoogleVolume[] }>(url.toString());
  return (body.items ?? []).map(toCandidate).filter((c): c is BookCandidate => c !== null);
}

