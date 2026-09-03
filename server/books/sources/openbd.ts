// openBD (版元ドットコム + JPRO)。 キー不要・和書の書影と書誌が正確。
// 検索はできず ISBN 引きのみなので、 他ソースが拾った ISBN の 「肉付け」 に使う。
// https://api.openbd.jp/v1/get?isbn=...

import { cleanAuthors, normalizeDate } from '../bib.js';
import type { BookCandidate } from '../types.js';
import { fetchJson } from './http.js';

const ENDPOINT = 'https://api.openbd.jp/v1/get';
const MAX_PER_REQUEST = 50;

interface OpenBdRecord {
  summary?: {
    isbn?: string;
    title?: string;
    volume?: string;
    series?: string;
    publisher?: string;
    pubdate?: string;
    cover?: string;
    author?: string;
  };
}

function toCandidate(record: OpenBdRecord | null): BookCandidate | null {
  const summary = record?.summary;
  if (!summary?.isbn || !summary.title) return null;
  const title = summary.volume ? `${summary.title} ${summary.volume}` : summary.title;
  return {
    isbn13: summary.isbn,
    title,
    authors: cleanAuthors((summary.author ?? '').split(/[,，]/)),
    publisher: summary.publisher || null,
    series: summary.series || null,
    publishedOn: normalizeDate(summary.pubdate ?? null),
    coverUrl: summary.cover || null,
    url: `https://www.hanmoto.com/bd/isbn/${summary.isbn}`,
    source: 'openbd',
    rating: null,
    ratingCount: null,
    salesRank: null,
  };
}

/** ISBN をまとめて引く。 未収録は結果に含まれない。 */
export async function lookupOpenBd(isbns: string[]): Promise<Map<string, BookCandidate>> {
  const out = new Map<string, BookCandidate>();
  const unique = [...new Set(isbns.filter(Boolean))];
  for (let i = 0; i < unique.length; i += MAX_PER_REQUEST) {
    const chunk = unique.slice(i, i + MAX_PER_REQUEST);
    const url = `${ENDPOINT}?isbn=${chunk.join(',')}`;
    const records = await fetchJson<(OpenBdRecord | null)[]>(url);
    for (const record of records) {
      const candidate = toCandidate(record);
      if (candidate?.isbn13) out.set(candidate.isbn13, candidate);
    }
  }
  return out;
}

/**
 * 候補に openBD の書影・出版社・発売日を上書きで足す。
 * 和書は openBD のほうが正確なので、 埋まっていない項目だけでなく書影は優先して差し替える。
 */
export async function enrichWithOpenBd(candidates: BookCandidate[]): Promise<BookCandidate[]> {
  const isbns = candidates.map((c) => c.isbn13).filter((v): v is string => v !== null);
  if (isbns.length === 0) return candidates;
  const found = await lookupOpenBd(isbns);
  return candidates.map((candidate) => {
    const hit = candidate.isbn13 ? found.get(candidate.isbn13) : undefined;
    if (!hit) return candidate;
    return {
      ...candidate,
      publisher: candidate.publisher ?? hit.publisher,
      series: candidate.series ?? hit.series,
      publishedOn: candidate.publishedOn ?? hit.publishedOn,
      coverUrl: hit.coverUrl ?? candidate.coverUrl,
      authors: candidate.authors.length > 0 ? candidate.authors : hit.authors,
    };
  });
}
