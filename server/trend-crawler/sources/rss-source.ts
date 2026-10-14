// RSS 1.0 (RDF) / RSS 2.0 / Atom を順位付きの一覧に変える。 並び順をそのまま順位とする。
// Google トレンドの検索数 (ht:approx_traffic) と はてブのブックマーク数 (hatena:bookmarkcount) は指標として拾う。

import { XMLParser } from 'fast-xml-parser';
import type { RawTrendItem } from '../types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  processEntities: false,
  cdataPropName: '__cdata',
});

type Node = Record<string, unknown>;

const NAMED_ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** 名前付き・数値の文字参照を 1 回だけ復号する (はてブの RSS は日本語を &#x...; で送ってくる)。 */
export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return textOf(value[0]);
  if (typeof value === 'object') {
    const node = value as Node;
    if (typeof node.__cdata === 'string') return node.__cdata;
    if (typeof node['#text'] === 'string') return node['#text'];
  }
  return '';
}

function clean(value: unknown): string {
  return decodeXmlEntities(textOf(value)).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function asArray(value: unknown): Node[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter((v): v is Node => typeof v === 'object' && v !== null);
}

function atomLink(links: unknown): string {
  const nodes = asArray(links);
  const alternate = nodes.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? nodes[0];
  if (alternate && typeof alternate['@_href'] === 'string') return alternate['@_href'];
  return textOf(links);
}

function metricOf(item: Node): string | null {
  const traffic = clean(item.approx_traffic);
  if (traffic) return `${traffic} 検索`;
  const bookmarks = clean(item.bookmarkcount);
  if (bookmarks) return `${bookmarks} users`;
  return null;
}

function httpUrlOrNull(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Google トレンドの item は link がフィード自身を指すので、 最初の関連ニュースの URL を使う。 */
function googleTrendsUrl(item: Node): string | null {
  const news = asArray(item.news_item)[0];
  return news ? httpUrlOrNull(clean(news.news_item_url)) : null;
}

export function parseTrendFeed(xml: string, limit: number): RawTrendItem[] {
  const doc = parser.parse(xml) as Node;
  const rdf = doc.RDF as Node | undefined;
  const channel = (doc.rss as Node | undefined)?.channel as Node | undefined;
  const feed = doc.feed as Node | undefined;

  let nodes: Node[];
  let isAtom = false;
  if (rdf) nodes = asArray(rdf.item);
  else if (channel) nodes = asArray(channel.item);
  else if (feed) { nodes = asArray(feed.entry); isAtom = true; }
  else throw new Error('RSS / Atom として読めませんでした');

  const items: RawTrendItem[] = [];
  for (const node of nodes) {
    if (items.length >= limit) break;
    const title = clean(node.title);
    if (!title) continue;
    const rawLink = isAtom ? atomLink(node.link) : clean(node.link);
    const url = node.approx_traffic !== undefined ? googleTrendsUrl(node) : httpUrlOrNull(rawLink);
    items.push({ rank: items.length + 1, title: title.slice(0, 300), subtitle: null, url, metric: metricOf(node) });
  }
  return items;
}
