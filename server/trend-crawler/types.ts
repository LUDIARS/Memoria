// トレンドクローラー ドメインの型。
//
// このディレクトリ (server/trend-crawler/) は他ドメインを import しない自己完結モジュール。
// 依存は better-sqlite3 (db ハンドル)・server/llm.ts (runLlm)・server/shared/ の公開取得ヘルパのみ。

/** トレンドのジャンル。 表示のまとまりと AI 要約の単位。 */
export type TrendGenre =
  | 'general' | 'youth' | 'news' | 'tech' | 'game' | 'anime' | 'music'
  | 'app' | 'book' | 'entertainment' | 'life' | 'global';

export const TREND_GENRES: readonly TrendGenre[] = [
  'general', 'youth', 'news', 'tech', 'game', 'anime', 'music', 'app', 'book', 'entertainment', 'life', 'global',
];

export const GENRE_LABELS: Record<TrendGenre, string> = {
  general: '総合 (検索・閲覧)',
  youth: '若者 (Z世代)',
  news: 'ニュース・社会',
  tech: 'テック',
  game: 'ゲーム',
  anime: 'アニメ・マンガ',
  music: '音楽',
  app: 'アプリ',
  book: '本',
  entertainment: 'エンタメ',
  life: '暮らし・知識',
  global: '海外',
};

/**
 * 取得方式。
 * - rss: RSS 1.0 (RDF) / RSS 2.0 / Atom。 並び順を順位とみなす。 Google トレンドの検索数・はてブ数を指標に拾う。
 * - apple_top: Apple のランキング JSON (rss.marketingtools.apple.com)。 URL で国・種類を指定する。
 * - wikipedia_top: Wikimedia の前日閲覧数ランキング。 URL は対象 Wikipedia (例 https://ja.wikipedia.org)。
 * - anilist_anime / anilist_manga: AniList GraphQL の TRENDING 順。
 * - hn_top: Hacker News の topstories。
 */
export type TrendSourceKind = 'rss' | 'apple_top' | 'wikipedia_top' | 'anilist_anime' | 'anilist_manga' | 'hn_top';

export const TREND_SOURCE_KINDS: readonly TrendSourceKind[] = [
  'rss', 'apple_top', 'wikipedia_top', 'anilist_anime', 'anilist_manga', 'hn_top',
];

export interface TrendSource {
  id: string;
  name: string;
  genre: TrendGenre;
  kind: TrendSourceKind;
  url: string;
  enabled: boolean;
}

export interface TrendCrawlerConfig {
  defaultsVersion: number;
  enabled: boolean;
  /** 巡回間隔 (時間)。 */
  intervalHours: number;
  /** 1 ソースから保存する件数。 */
  itemsPerSource: number;
  /** 履歴の保持日数。 これより古い取得結果は巡回のたびに消す。 */
  retentionDays: number;
  /** 巡回後に AI でジャンル別の要約を作るか。 */
  summarize: boolean;
  sources: TrendSource[];
}

/** 取得直後の 1 件 (順位は 1 始まり)。 */
export interface RawTrendItem {
  rank: number;
  title: string;
  /** 補足 (アーティスト名・著者名など)。 */
  subtitle: string | null;
  url: string | null;
  /** 指標の表示文字列 (例 "1000+ 検索" / "123 users" / "45,000 閲覧")。 */
  metric: string | null;
}

export type TrendMovementStatus = 'new' | 'up' | 'down' | 'same' | 'unknown';

export interface TrendMovement {
  status: TrendMovementStatus;
  /** 前回順位 - 今回順位 (上がると正)。 new / unknown は null。 */
  delta: number | null;
}

export interface TrendItemView extends RawTrendItem {
  key: string;
  movement: TrendMovement;
  /** このソースで初めて見えた日時 (保持期間内)。 */
  firstSeenAt: string | null;
}

export interface TrendSourceView {
  sourceId: string;
  name: string;
  kind: TrendSourceKind;
  url: string;
  /** 表示している取得結果の時刻 (成功した最新)。 */
  fetchedAt: string | null;
  /** 最新の巡回が失敗していればその内容。 */
  error: string | null;
  items: TrendItemView[];
}

export interface TrendGenreView {
  genre: TrendGenre;
  label: string;
  summary: string | null;
  sources: TrendSourceView[];
}

/** 複数ソースに同じ話題が出ているもの。 */
export interface TrendCrossHit {
  key: string;
  title: string;
  sources: { sourceId: string; name: string; genre: TrendGenre; rank: number }[];
}

export interface TrendSummary {
  generatedAt: string;
  overall: string | null;
  genres: Partial<Record<TrendGenre, string>>;
}

export interface TrendOverview {
  lastCrawledAt: string | null;
  summary: TrendSummary | null;
  crossHits: TrendCrossHit[];
  genres: TrendGenreView[];
}

export interface TrendCrawlResult {
  crawledAt: string;
  ok: number;
  failed: { sourceId: string; error: string }[];
  summaryError: string | null;
}
