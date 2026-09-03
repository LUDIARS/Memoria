// NDL サーチ OpenSearch API (キー不要)。 和書の新刊網羅がいちばん強いので
// 著者・シリーズの新刊チェックの主軸に使う。
// https://ndlsearch.ndl.go.jp/api/opensearch?creator=...&cnt=...

import { XMLParser } from 'fast-xml-parser';
import { cleanAuthors, normalizeDate, normalizeIsbn13 } from '../bib.js';
import type { BookCandidate } from '../types.js';
import { fetchXml } from './http.js';

const ENDPOINT = 'https://ndlsearch.ndl.go.jp/api/opensearch';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  // 外部 XML のエンティティ展開は不要で、増幅攻撃の面積になるため無効化する。
  processEntities: false,
});

type Node = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return text(value[0]);
  if (value && typeof value === 'object') {
    const node = value as Node;
    if (typeof node['#text'] === 'string') return node['#text'];
  }
  return '';
}

/** dc:identifier は種別属性で ISBN / JP番号 を出し分けている。 ISBN のものだけ拾う。 */
function pickIsbn(item: Node): string | null {
  for (const entry of asArray(item.identifier)) {
    const node = entry as Node;
    const type = String(node['@_type'] ?? '');
    const value = text(entry);
    if (/ISBN/i.test(type) || /^[0-9-]{10,17}$/.test(value)) {
      const isbn = normalizeIsbn13(value);
      if (isbn) return isbn;
    }
  }
  return null;
}

function toCandidate(item: Node): BookCandidate | null {
  const title = text(item.title);
  if (!title) return null;
  const volume = text(item.volume);
  return {
    isbn13: pickIsbn(item),
    title: volume ? `${title} ${volume}` : title,
    authors: cleanAuthors(asArray(item.creator).map(text)),
    publisher: text(item.publisher) || null,
    series: text(item.seriesTitle) || null,
    // dcterms:issued が発売年月。 無ければ pubDate (登録日) にフォールバック。
    publishedOn: normalizeDate(text(item.issued) || text(item.date)) ?? null,
    coverUrl: null,
    url: text(item.link) || null,
    source: 'ndl',
    rating: null,
    ratingCount: null,
    salesRank: null,
  };
}

export interface NdlQuery {
  creator?: string;
  title?: string;
  /** YYYY-MM-DD。 この日以降に出たものだけ。 */
  from?: string;
  limit?: number;
}

export async function searchNdl(query: NdlQuery): Promise<BookCandidate[]> {
  if (!query.creator && !query.title) return [];
  const url = new URL(ENDPOINT);
  if (query.creator) url.searchParams.set('creator', query.creator);
  if (query.title) url.searchParams.set('title', query.title);
  if (query.from) url.searchParams.set('from', query.from);
  url.searchParams.set('cnt', String(Math.min(query.limit ?? 30, 100)));
  // 図書 (mediatype=1) に絞る。 雑誌・電子資料まで拾うとノイズが多い。
  url.searchParams.set('mediatype', '1');
  const xml = await fetchXml(url.toString());
  const parsed = parser.parse(xml) as Node;
  const channel = (parsed.rss as Node | undefined)?.channel as Node | undefined;
  const items = asArray(channel?.item) as Node[];
  return items.map(toCandidate).filter((c): c is BookCandidate => c !== null);
}
