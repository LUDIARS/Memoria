// フィード取得 (HTTP) + 種別判定 + ワンクリック登録プリセット。
//
// fetchPageHtml は content-type を text/html に絞っているため RSS には使えない。
// ここで XML/RSS 用の取得関数を別に持つ。

import type { RssFeedKind, DiscoveredFeed } from './types.js';
import { assertFetchableFeedUrl } from './url-guard.js';

const MAX_BYTES = 5 * 1024 * 1024; // 5MB 上限 (巨大フィードの暴走防止)
const MAX_REDIRECTS = 5;

/**
 * RSS/Atom XML を取得して文字列で返す。 content-type は xml 系を許容。
 *
 * SSRF 対策: 取得先 (初回 URL + 各リダイレクト hop) を assertFetchableFeedUrl で
 * 検査し、内部/予約レンジを遮断する。リダイレクトは redirect:'manual' で hop ごと
 * に再検査する (follow 任せだと内部 URL へ飛ばされても検査できないため)。
 */
export async function fetchFeedXml(url: string, timeoutMs = 20_000): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      await assertFetchableFeedUrl(current);
      const res = await fetch(current, {
        signal: ac.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Memoria-RSS/0.1',
          'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5',
          'Accept-Language': 'ja,en;q=0.9',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`HTTP ${res.status} without Location`);
        if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
        current = new URL(loc, current).toString();
        continue; // 次 hop の先頭で assertFetchableFeedUrl により再検査
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BYTES) throw new Error(`feed too large (${buf.byteLength} bytes)`);
      return new TextDecoder('utf-8').decode(buf);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** サイト URL から登録できる RSS/Atom フィードを発見する (alreadyRegistered は呼び側で付与)。 */
export async function discoverFeeds(siteUrl: string): Promise<Omit<DiscoveredFeed, 'alreadyRegistered'>[]> {
  let body: string;
  try {
    body = await fetchFeedXml(siteUrl, 15_000);
  } catch {
    return [];
  }
  const head = body.slice(0, 500).toLowerCase();

  // 渡された URL 自体が既にフィードならそれを返す。
  if (/^\s*<\?xml|<rss|<feed|<rdf/.test(head)) {
    const m = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return [{
      url: siteUrl,
      title: m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) : null,
      kind: detectFeedKind(siteUrl),
    }];
  }

  // HTML の <link rel="alternate" type="application/rss+xml|atom+xml" href="...">。
  const out: Omit<DiscoveredFeed, 'alreadyRegistered'>[] = [];
  const seen = new Set<string>();
  const linkRe = /<link\b[^>]*>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(body)) !== null) {
    const tag = lm[0];
    if (!/rel\s*=\s*["']?alternate/i.test(tag)) continue;
    if (!/type\s*=\s*["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    let abs: string;
    try { abs = new URL(href, siteUrl).toString(); } catch { continue; }
    if (seen.has(abs)) continue;
    seen.add(abs);
    const title = tag.match(/title\s*=\s*["']([^"']*)["']/i)?.[1] || null;
    out.push({ url: abs, title: title ? title.trim().slice(0, 200) : null, kind: detectFeedKind(abs) });
  }
  return out;
}

/** URL から種別を推定する (表示・パースの出し分け用)。 */
export function detectFeedKind(url: string): RssFeedKind {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* ignore */ }
  if (host.includes('trends.google')) return 'google_trends';
  if (host.endsWith('hatena.ne.jp') || host.includes('hatena')) return 'hatena';
  return 'rss';
}

export interface FeedPreset {
  label: string;
  url: string;
  kind: RssFeedKind;
  category: string;
  description: string;
}

/** ワンクリックで登録できる代表的なソースのカタログ。 自由に増やせる。 */
export const FEED_PRESETS: FeedPreset[] = [
  // ── トレンド ──
  {
    label: 'Google トレンド (日本・急上昇)',
    url: 'https://trends.google.co.jp/trending/rss?geo=JP',
    kind: 'google_trends', category: 'トレンド',
    description: '日本でいま急激に検索されているワード (マクロトレンド)',
  },
  {
    label: 'Google トレンド (US)',
    url: 'https://trends.google.com/trending/rss?geo=US',
    kind: 'google_trends', category: 'トレンド',
    description: '米国の急上昇検索ワード',
  },
  {
    label: 'Google ニュース検索 (例: AI)',
    url: 'https://news.google.com/rss/search?hl=ja&gl=JP&ceid=JP:ja&q=AI',
    kind: 'rss', category: 'トレンド',
    description: 'キーワード検索の RSS 化。 登録後に URL 末尾の q= を編集してテーマ変更可',
  },
  {
    label: 'はてブ 人気エントリー (総合)',
    url: 'https://b.hatena.ne.jp/hotentry.rss',
    kind: 'hatena', category: 'トレンド',
    description: 'はてブで多くブックマークされた話題のページ',
  },
  {
    label: 'はてブ 新着 (総合)',
    url: 'https://b.hatena.ne.jp/entrylist.rss',
    kind: 'hatena', category: 'トレンド',
    description: '人気になる前の早耳ネタ',
  },
  // ── テック ──
  {
    label: 'はてブ テクノロジー',
    url: 'https://b.hatena.ne.jp/hotentry/it.rss',
    kind: 'hatena', category: 'テック',
    description: 'はてブ人気の IT/テクノロジーカテゴリ',
  },
  {
    label: 'Publickey',
    url: 'https://www.publickey1.jp/atom.xml',
    kind: 'rss', category: 'テック',
    description: 'エンタープライズIT / クラウド / 開発',
  },
  {
    label: 'Zenn トレンド',
    url: 'https://zenn.dev/feed',
    kind: 'rss', category: 'テック',
    description: '日本語技術記事コミュニティ',
  },
  {
    label: 'Hacker News',
    url: 'https://news.ycombinator.com/rss',
    kind: 'rss', category: 'テック',
    description: '海外テックの定番。 HN フロントページ',
  },
  {
    label: 'Qiita 人気記事',
    url: 'https://qiita.com/popular-items/feed',
    kind: 'rss', category: 'テック',
    description: '日本語技術記事コミュニティ (人気)',
  },
  {
    label: 'ITmedia NEWS',
    url: 'https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml',
    kind: 'rss', category: 'テック',
    description: 'IT・ガジェット・速報',
  },
  {
    label: '＠IT',
    url: 'https://rss.itmedia.co.jp/rss/2.0/ait.xml',
    kind: 'rss', category: 'テック',
    description: 'エンジニア向け技術情報',
  },
  {
    label: '企業テックブログまとめ',
    url: 'https://yamadashy.github.io/tech-blog-rss-feed/feeds/rss.xml',
    kind: 'rss', category: 'テック',
    description: '有志による企業テックブログ一括まとめ',
  },
  {
    label: 'GIGAZINE',
    url: 'https://gigazine.net/news/rss_2.0/',
    kind: 'rss', category: 'テック',
    description: 'テック / サイエンス / カルチャー',
  },
  // ── ニュース / ビジネス ──
  {
    label: 'はてブ 世の中 (ニュース)',
    url: 'https://b.hatena.ne.jp/hotentry/social.rss',
    kind: 'hatena', category: 'ニュース',
    description: 'はてブ人気の社会・ニュースカテゴリ',
  },
  {
    label: 'はてブ 総合ホットエントリー',
    url: 'https://b.hatena.ne.jp/hotentry/all.rss',
    kind: 'hatena', category: 'ニュース',
    description: 'はてブ全カテゴリの人気エントリー',
  },
  {
    label: 'Reddit r/technology',
    url: 'https://www.reddit.com/r/technology/.rss',
    kind: 'rss', category: 'ニュース',
    description: '海外 Reddit のテクノロジー板',
  },
  {
    label: 'はてブ 経済・政治',
    url: 'https://b.hatena.ne.jp/hotentry/economics.rss',
    kind: 'hatena', category: 'ビジネス',
    description: 'はてブ人気の経済・政治・ビジネス',
  },
  {
    label: 'NHK ニュース 主要',
    url: 'https://www.nhk.or.jp/rss/news/cat0.xml',
    kind: 'rss', category: 'ニュース',
    description: 'NHK の主要ニュース',
  },
  {
    label: 'TechCrunch',
    url: 'https://techcrunch.com/feed/',
    kind: 'rss', category: 'ビジネス',
    description: 'スタートアップ / VC / 新製品 (英語)',
  },
];
