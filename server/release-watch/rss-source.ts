import { XMLParser } from 'fast-xml-parser';
import { fetchPublicText } from '../shared/public-fetch.js';
import type { RawRelease, ReleaseSource } from './types.js';

const MAX_BODY_CHARS = 12_000;

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

function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return textOf(value[0]);
  if (typeof value === 'object') {
    const node = value as Node;
    if (typeof node.__cdata === 'string') return node.__cdata;
    if (typeof node['#text'] === 'string') return node['#text'];
    if (typeof node['@_href'] === 'string') return node['@_href'];
  }
  return '';
}

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
}

/**
 * Atom の `type="html"` は HTML がエンティティ化されて入るので、 先に復号してからタグを落とす。
 * 復号は 1 回だけ。 2 回掛けると `&amp;lt;` (= 本文として見せたい literal な `&lt;`) が
 * タグ剥がし後に `<` へ戻り、 本文が壊れる。
 */
export function stripHtml(html: string): string {
  return decodeEntities(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d|div|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function asArray(value: unknown): Node[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter((v): v is Node => typeof v === 'object' && v !== null);
}

function pickAtomLink(links: unknown): string {
  const nodes = asArray(links);
  const alternate = nodes.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate');
  return textOf(alternate ?? nodes[0] ?? links);
}

function toIso(value: string): string | null {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** RSS 2.0 / Atom の両方を RawRelease[] に正規化する (順序は feed のまま = 新しい順想定)。 */
export function parseReleaseFeed(source: ReleaseSource, xml: string): RawRelease[] {
  return parseReleaseFeedWithNotes(source, xml).map(({ notesLink: _notesLink, ...release }) => release);
}

export function parseReleaseFeedWithNotes(source: ReleaseSource, xml: string): (RawRelease & { notesLink: string | null })[] {
  let doc: Node;
  try { doc = parser.parse(xml) as Node; } catch { throw new Error('feed is not valid XML'); }
  const rss = doc.rss as Node | undefined;
  const feed = doc.feed as Node | undefined;
  if (!rss && !feed) throw new Error('feed is neither RSS nor Atom');
  const items = rss ? asArray((rss.channel as Node | undefined)?.item) : asArray(feed?.entry);
  const include = source.includePattern ? new RegExp(source.includePattern) : null;
  const out: (RawRelease & { notesLink: string | null })[] = [];
  for (const item of items) {
    const title = textOf(item.title).trim();
    if (!title || (include && !include.test(title))) continue;
    const url = rss ? textOf(item.link) : pickAtomLink(item.link);
    const published = textOf(item.pubDate) || textOf(item.published) || textOf(item.updated) || textOf(item.date);
    const bodyHtml = textOf(item.encoded) || textOf(item.content) || textOf(item.description) || textOf(item.summary);
    out.push({
      version: title,
      url: url || source.url,
      publishedAt: published ? toIso(published) : null,
      body: stripHtml(bodyHtml).slice(0, MAX_BODY_CHARS),
      notesLink: textOf(item.releaseNotesLink).trim() || null,
    });
  }
  return out;
}

const STUB_BODY_CHARS = 120;
const NOTES_MAX_BYTES = 2 * 1024 * 1024;
// 本文補完は 1 件ごとに追加の HTTP 取得 (最大 2MB / 30 秒) が走る。 タイトルだけの feed だと
// 全件で直列に走って 1 ソースに数分掛かるので、 新しい方から数件に絞る。
const MAX_ENRICHED_ENTRIES = 3;

export type FeedTextFetcher = (url: string, options?: { accept?: string; maxBytes?: number }) => Promise<{ text: string }>;

function isHttpUrl(value: string): boolean {
  try { const p = new URL(value).protocol; return p === 'http:' || p === 'https:'; } catch { return false; }
}

/**
 * feed 本文がタイトルの言い換え程度 (Unity の LTS feed など) なら、 `releaseNotesLink` か item link の
 * 本文を代わりに使う。 失敗しても feed 本文のまま進める。
 */
async function enrichStubBody(release: RawRelease & { notesLink: string | null }, fetchText: FeedTextFetcher): Promise<RawRelease> {
  const { notesLink, ...base } = release;
  if (base.body.length > STUB_BODY_CHARS) return base;
  const candidate = notesLink && isHttpUrl(notesLink) ? notesLink : (isHttpUrl(base.url) ? base.url : null);
  if (!candidate) return base;
  try {
    const { text } = await fetchText(candidate, { accept: 'text/markdown,text/plain,text/html;q=0.9,*/*;q=0.5', maxBytes: NOTES_MAX_BYTES });
    const body = (/<html|<body|<div/i.test(text) ? stripHtml(text) : text).trim();
    return body.length > base.body.length ? { ...base, body: body.slice(0, MAX_BODY_CHARS) } : base;
  } catch {
    return base;
  }
}

export async function fetchRssReleases(
  source: ReleaseSource,
  limit: number,
  fetchText: FeedTextFetcher = fetchPublicText,
): Promise<RawRelease[]> {
  const { text } = await fetchText(source.url, { accept: 'application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.5' });
  const items = parseReleaseFeedWithNotes(source, text).slice(0, limit);
  const out: RawRelease[] = [];
  for (const [index, item] of items.entries()) {
    const { notesLink: _notesLink, ...base } = item;
    out.push(index < MAX_ENRICHED_ENTRIES ? await enrichStubBody(item, fetchText) : base);
  }
  return out;
}
