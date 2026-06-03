// フィード取得 (HTTP) + 種別判定 + ワンクリック登録プリセット。
//
// fetchPageHtml は content-type を text/html に絞っているため RSS には使えない。
// ここで XML/RSS 用の取得関数を別に持つ。

import type { RssFeedKind } from './types.js';

const MAX_BYTES = 5 * 1024 * 1024; // 5MB 上限 (巨大フィードの暴走防止)

/** RSS/Atom XML を取得して文字列で返す。 content-type は xml 系を許容。 */
export async function fetchFeedXml(url: string, timeoutMs = 20_000): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Memoria-RSS/0.1',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5',
        'Accept-Language': 'ja,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error(`feed too large (${buf.byteLength} bytes)`);
    return new TextDecoder('utf-8').decode(buf);
  } finally {
    clearTimeout(timer);
  }
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

/** ワンクリックで登録できる代表的なトレンドソース。 */
export const FEED_PRESETS: FeedPreset[] = [
  {
    label: 'Google トレンド (日本・急上昇)',
    url: 'https://trends.google.co.jp/trending/rss?geo=JP',
    kind: 'google_trends',
    category: 'トレンド',
    description: '日本でいま急激に検索されているワード (マクロトレンド)',
  },
  {
    label: 'はてなブックマーク 人気エントリー',
    url: 'https://b.hatena.ne.jp/hotentry.rss',
    kind: 'hatena',
    category: 'トレンド',
    description: 'はてブで多くブックマークされた話題のページ (総合)',
  },
  {
    label: 'はてなブックマーク テクノロジー',
    url: 'https://b.hatena.ne.jp/hotentry/it.rss',
    kind: 'hatena',
    category: 'テック',
    description: 'はてブ人気エントリーの IT/テクノロジーカテゴリ',
  },
  {
    label: 'はてなブックマーク 新着 (総合)',
    url: 'https://b.hatena.ne.jp/entrylist.rss',
    kind: 'hatena',
    category: 'トレンド',
    description: 'はてブ新着エントリー (人気になる前の早耳ネタ)',
  },
];
