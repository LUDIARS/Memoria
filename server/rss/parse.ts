// RSS 2.0 / Atom / Google トレンド RSS を中立的な ParsedFeed に変換する。
//
// fast-xml-parser で XML→object にした後、 フォーマット差を吸収して
// ParsedArticle[] に正規化する。 namespace prefix (ht: / media: / dc:) は
// removeNSPrefix で剥がすので、 `ht:approx_traffic` は `approx_traffic` で読める。

import { XMLParser } from 'fast-xml-parser';
import type { ParsedFeed, ParsedArticle } from './types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,    // 数値文字列を勝手に number 化しない (guid 等を壊さない)
  processEntities: false,  // entity 展開保護 (billion laughs) で弾かれるのを回避。
  //                          &amp; 等は下の decodeEntities / stripHtml で個別に戻す。
  cdataPropName: '__cdata',
});

/** url 等 stripHtml を通さない値の基本 entity を戻す。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

// ── 小さな型安全アクセサ (backend strict 用) ─────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** タグ値を文字列化。 CDATA / { '#text' } / プレーン文字列の混在を吸収。 */
function text(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  const rec = asRecord(v);
  if (rec) {
    if (typeof rec.__cdata === 'string') return rec.__cdata;
    if (typeof rec['#text'] === 'string') return rec['#text'];
  }
  return '';
}

function stripHtml(s: string): string {
  return decodeEntities(
    s
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function toIso(raw: string): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max).trimEnd() + '…' : s;
}

function firstImageInHtml(html: string): string | null {
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

/** Atom の link 配列から代表 URL を取り出す。 */
function atomLink(link: unknown): string {
  for (const l of asArray(link)) {
    const r = asRecord(l);
    if (r && typeof r['@_href'] === 'string') {
      const rel = r['@_rel'];
      if (rel === undefined || rel === 'alternate') return r['@_href'];
    }
  }
  // rel 指定が無く href だけの最初の 1 本
  for (const l of asArray(link)) {
    const r = asRecord(l);
    if (r && typeof r['@_href'] === 'string') return r['@_href'];
    if (typeof l === 'string') return l;
  }
  return '';
}

function pickImage(item: Record<string, unknown>, summaryHtml: string): string | null {
  // RSS enclosure / media:content / media:thumbnail
  for (const key of ['enclosure', 'content', 'thumbnail']) {
    for (const e of asArray(item[key])) {
      const r = asRecord(e);
      const url = r?.['@_url'];
      if (typeof url === 'string' && /^https?:\/\//.test(url)) return url;
    }
  }
  // Google トレンド <ht:picture>
  const pic = text(item.picture);
  if (/^https?:\/\//.test(pic)) return pic;
  // description 内の最初の img
  return firstImageInHtml(summaryHtml);
}

// ── RSS 2.0 item → ParsedArticle ─────────────────────────────────────────────

function fromRssItem(item: Record<string, unknown>): ParsedArticle | null {
  const link = decodeEntities(text(item.link).trim());
  const title = stripHtml(text(item.title)) || '(無題)';

  const rawSummary = text(item.description) || text(item.encoded) || text(item.summary);
  const summary = rawSummary ? clip(stripHtml(rawSummary), 400) : null;
  const author = stripHtml(text(item.creator) || text(item.author)) || null;
  const publishedAt = toIso(text(item.pubDate) || text(item.date) || text(item.published));

  // Google トレンド固有: 検索ボリューム + 関連ニュース。
  const meta: Record<string, unknown> = {};
  const traffic = text(item.approx_traffic).trim();
  if (traffic) meta.approx_traffic = traffic;
  const news: Array<{ title: string; url: string; source: string }> = [];
  for (const n of asArray(item.news_item)) {
    const r = asRecord(n);
    if (!r) continue;
    news.push({
      title: stripHtml(text(r.news_item_title)),
      url: decodeEntities(text(r.news_item_url).trim()),
      source: stripHtml(text(r.news_item_source)),
    });
  }
  if (news.length) meta.news = news;

  // Google トレンドは item に <guid>/個別 <link> が無く、 channel link が
  // 全 item で共有されることがある → タイトル (=急上昇ワード) で一意化し、
  // 遷移先は関連ニュース or キーワード検索にする。
  const isTrend = !!traffic || news.length > 0;
  const explicitGuid = text(item.guid).trim();
  const guidRaw = explicitGuid
    || (isTrend ? `trend:${title}` : (link || `${title}|${text(item.pubDate)}`));
  const url = isTrend
    ? (news[0]?.url || link || `https://www.google.com/search?q=${encodeURIComponent(title)}`)
    : link;

  if (!url && !title) return null;

  return {
    guid: guidRaw.slice(0, 400),
    url,
    title,
    summary,
    author,
    imageUrl: pickImage(item, rawSummary),
    publishedAt,
    meta: Object.keys(meta).length ? meta : null,
  };
}

// ── Atom entry → ParsedArticle ───────────────────────────────────────────────

function fromAtomEntry(entry: Record<string, unknown>): ParsedArticle | null {
  const url = decodeEntities(atomLink(entry.link).trim());
  const title = stripHtml(text(entry.title)) || '(無題)';
  if (!url && !title) return null;
  const guidRaw = text(entry.id) || url || title;
  const rawSummary = text(entry.summary) || text(entry.content);
  const summary = rawSummary ? clip(stripHtml(rawSummary), 400) : null;
  const authorRec = asRecord(asArray(entry.author)[0]);
  const author = authorRec ? stripHtml(text(authorRec.name)) || null : null;
  const publishedAt = toIso(text(entry.published) || text(entry.updated));
  return {
    guid: guidRaw.slice(0, 400),
    url,
    title,
    summary,
    author,
    imageUrl: pickImage(entry, rawSummary),
    publishedAt,
    meta: null,
  };
}

// ── entry point ──────────────────────────────────────────────────────────────

export function parseFeedXml(xml: string): ParsedFeed {
  const root = asRecord(parser.parse(xml));
  if (!root) throw new Error('XML root をパースできませんでした');

  // RSS 2.0: <rss><channel>...</channel></rss>
  const rss = asRecord(root.rss);
  const channel = rss ? asRecord(rss.channel) : null;
  if (channel) {
    const articles: ParsedArticle[] = [];
    for (const it of asArray(channel.item)) {
      const r = asRecord(it);
      if (!r) continue;
      const a = fromRssItem(r);
      if (a) articles.push(a);
    }
    return {
      title: stripHtml(text(channel.title)) || null,
      siteUrl: text(channel.link).trim() || null,
      description: stripHtml(text(channel.description)) || null,
      articles,
    };
  }

  // Atom: <feed><entry>...</entry></feed>
  const feed = asRecord(root.feed);
  if (feed) {
    const articles: ParsedArticle[] = [];
    for (const en of asArray(feed.entry)) {
      const r = asRecord(en);
      if (!r) continue;
      const a = fromAtomEntry(r);
      if (a) articles.push(a);
    }
    return {
      title: stripHtml(text(feed.title)) || null,
      siteUrl: atomLink(feed.link).trim() || null,
      description: stripHtml(text(feed.subtitle)) || null,
      articles,
    };
  }

  // RDF (RSS 1.0): <rdf:RDF><channel/> + <item/> は RDF 直下
  const rdf = asRecord(root.RDF);
  if (rdf) {
    const ch = asRecord(rdf.channel);
    const articles: ParsedArticle[] = [];
    for (const it of asArray(rdf.item)) {
      const r = asRecord(it);
      if (!r) continue;
      const a = fromRssItem(r);
      if (a) articles.push(a);
    }
    return {
      title: ch ? stripHtml(text(ch.title)) || null : null,
      siteUrl: ch ? text(ch.link).trim() || null : null,
      description: ch ? stripHtml(text(ch.description)) || null : null,
      articles,
    };
  }

  throw new Error('対応していないフィード形式です (RSS/Atom/RDF のいずれでもありません)');
}
