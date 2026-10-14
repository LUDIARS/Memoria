// 既定のトレンド取得先。 API キー不要で公開されている一覧・ランキングだけを使う。
// 追加・無効化は画面の設定から行える。

import type { TrendSource } from './types.js';

const APPLE = 'https://rss.marketingtools.apple.com/api/v2/jp';
const HATENA = 'https://b.hatena.ne.jp/hotentry';

const INITIAL_SOURCES: TrendSource[] = [
  // ── 総合 ──
  { id: 'google-trends-jp', name: 'Google トレンド (日本・急上昇)', genre: 'general', kind: 'rss', url: 'https://trends.google.co.jp/trending/rss?geo=JP', enabled: true },
  { id: 'wikipedia-ja', name: 'Wikipedia 日本語版 (前日の閲覧数)', genre: 'general', kind: 'wikipedia_top', url: 'https://ja.wikipedia.org', enabled: true },
  { id: 'hatena-all', name: 'はてブ 総合', genre: 'general', kind: 'rss', url: `${HATENA}.rss`, enabled: true },
  // ── ニュース・社会 ──
  { id: 'hatena-social', name: 'はてブ 世の中', genre: 'news', kind: 'rss', url: `${HATENA}/social.rss`, enabled: true },
  { id: 'hatena-economics', name: 'はてブ 政治と経済', genre: 'news', kind: 'rss', url: `${HATENA}/economics.rss`, enabled: true },
  // ── テック ──
  { id: 'hatena-it', name: 'はてブ テクノロジー', genre: 'tech', kind: 'rss', url: `${HATENA}/it.rss`, enabled: true },
  { id: 'zenn', name: 'Zenn トレンド', genre: 'tech', kind: 'rss', url: 'https://zenn.dev/feed', enabled: true },
  { id: 'hacker-news', name: 'Hacker News', genre: 'tech', kind: 'hn_top', url: 'https://news.ycombinator.com', enabled: true },
  { id: 'product-hunt', name: 'Product Hunt', genre: 'tech', kind: 'rss', url: 'https://www.producthunt.com/feed', enabled: true },
  // ── ゲーム ──
  { id: 'hatena-game', name: 'はてブ アニメとゲーム', genre: 'game', kind: 'rss', url: `${HATENA}/game.rss`, enabled: true },
  { id: 'reddit-gaming', name: 'Reddit r/gaming (今日の上位)', genre: 'game', kind: 'rss', url: 'https://www.reddit.com/r/gaming/top/.rss?t=day', enabled: true },
  // ── アニメ・マンガ ──
  { id: 'anilist-anime', name: 'AniList アニメ (トレンド順)', genre: 'anime', kind: 'anilist_anime', url: 'https://anilist.co/search/anime/trending', enabled: true },
  { id: 'anilist-manga', name: 'AniList マンガ (トレンド順)', genre: 'anime', kind: 'anilist_manga', url: 'https://anilist.co/search/manga/trending', enabled: true },
  // ── 音楽 ──
  { id: 'apple-music-jp', name: 'Apple Music トップソング (日本)', genre: 'music', kind: 'apple_top', url: `${APPLE}/music/most-played/50/songs.json`, enabled: true },
  // ── アプリ ──
  { id: 'app-store-free-jp', name: 'App Store 無料アプリ (日本)', genre: 'app', kind: 'apple_top', url: `${APPLE}/apps/top-free/50/apps.json`, enabled: true },
  { id: 'app-store-paid-jp', name: 'App Store 有料アプリ (日本)', genre: 'app', kind: 'apple_top', url: `${APPLE}/apps/top-paid/50/apps.json`, enabled: true },
  // ── 本 ──
  { id: 'apple-books-paid-jp', name: 'Apple Books 有料 (日本)', genre: 'book', kind: 'apple_top', url: `${APPLE}/books/top-paid/50/books.json`, enabled: true },
  // ── エンタメ ──
  { id: 'hatena-entertainment', name: 'はてブ エンタメ', genre: 'entertainment', kind: 'rss', url: `${HATENA}/entertainment.rss`, enabled: true },
  { id: 'hatena-fun', name: 'はてブ おもしろ', genre: 'entertainment', kind: 'rss', url: `${HATENA}/fun.rss`, enabled: true },
  { id: 'apple-podcasts-jp', name: 'Apple Podcasts トップ番組 (日本)', genre: 'entertainment', kind: 'apple_top', url: `${APPLE}/podcasts/top/50/podcasts.json`, enabled: true },
  // ── 暮らし・知識 ──
  { id: 'hatena-life', name: 'はてブ 暮らし', genre: 'life', kind: 'rss', url: `${HATENA}/life.rss`, enabled: true },
  { id: 'hatena-knowledge', name: 'はてブ 学び', genre: 'life', kind: 'rss', url: `${HATENA}/knowledge.rss`, enabled: true },
  // ── 海外 ──
  { id: 'google-trends-us', name: 'Google トレンド (米国・急上昇)', genre: 'global', kind: 'rss', url: 'https://trends.google.com/trending/rss?geo=US', enabled: true },
  { id: 'reddit-popular', name: 'Reddit r/popular', genre: 'global', kind: 'rss', url: 'https://www.reddit.com/r/popular/.rss', enabled: true },
  { id: 'wikipedia-en', name: 'Wikipedia 英語版 (前日の閲覧数)', genre: 'global', kind: 'wikipedia_top', url: 'https://en.wikipedia.org', enabled: true },
];

/** Google ニュースの検索結果 RSS (直近 7 日)。 若者向けの話題は公開ランキングが少ないため、 報道から拾う。 */
function googleNewsSearch(query: string, locale: 'ja' | 'en'): string {
  const q = encodeURIComponent(`${query} when:7d`);
  return locale === 'ja'
    ? `https://news.google.com/rss/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`
    : `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

/** 版 2: 若者 (Z世代) ジャンル。 TikTok・Instagram・X の公式トレンドは API キーが要るので含めない。 */
const YOUTH_SOURCES: TrendSource[] = [
  { id: 'youth-gn-genz', name: 'Google ニュース「Z世代 トレンド」', genre: 'youth', kind: 'rss', url: googleNewsSearch('Z世代 トレンド', 'ja'), enabled: true },
  { id: 'youth-gn-tiktok', name: 'Google ニュース「TikTok 流行」', genre: 'youth', kind: 'rss', url: googleNewsSearch('TikTok 流行', 'ja'), enabled: true },
  { id: 'youth-gn-highschool', name: 'Google ニュース「女子高生 流行」', genre: 'youth', kind: 'rss', url: googleNewsSearch('女子高生 流行', 'ja'), enabled: true },
  { id: 'youth-gn-slang', name: 'Google ニュース「若者言葉」', genre: 'youth', kind: 'rss', url: googleNewsSearch('若者言葉', 'ja'), enabled: true },
  { id: 'youth-gn-genz-en', name: 'Google News "Gen Z trend" (英語圏)', genre: 'youth', kind: 'rss', url: googleNewsSearch('Gen Z trend', 'en'), enabled: true },
  { id: 'reddit-genz', name: 'Reddit r/GenZ (今日の上位)', genre: 'youth', kind: 'rss', url: 'https://www.reddit.com/r/GenZ/top/.rss?t=day', enabled: true },
];

/**
 * 既定ソースを追加した版ごとに並べる。 保存済み設定は defaultsVersion より新しい版のソースだけを
 * 読み込み時に足す (config.ts withNewDefaultSources)。 既定を増やすときは新しい版を足す。
 */
export const DEFAULT_TREND_SOURCE_RELEASES: { version: number; sources: TrendSource[] }[] = [
  { version: 1, sources: INITIAL_SOURCES },
  { version: 2, sources: YOUTH_SOURCES },
];

export const DEFAULT_TREND_SOURCES: TrendSource[] = DEFAULT_TREND_SOURCE_RELEASES.flatMap((release) => release.sources);
