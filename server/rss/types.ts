// RSS / トレンド取り込みドメインの行型 + 共通型。
//
// このディレクトリ (server/rss/) は将来 rss サービスとして切り出せるよう
// Memoria 固有の path / 他ドメインへの import を持たない自己完結モジュール。
// 依存は better-sqlite3 (db ハンドル) と server/llm.ts (runLlm) のみ。

/** フィード種別。 parse / 表示の出し分けに使う。 */
export type RssFeedKind = 'rss' | 'hatena' | 'google_trends';

/** 記事の AI スコアリング状態。 */
export type RssAiStatus = 'pending' | 'done' | 'skip' | 'error';

export interface RssFeedRow {
  id: number;
  url: string;
  kind: RssFeedKind;
  title: string | null;
  site_url: string | null;
  description: string | null;
  category: string | null;
  enabled: number;            // 0 | 1
  last_fetched_at: string | null;
  last_status: string | null; // 'ok' | 'error'
  last_error: string | null;
  created_at: string;
}

export interface RssArticleRow {
  id: number;
  feed_id: number;
  guid: string;
  url: string;
  title: string;
  summary: string | null;
  author: string | null;
  image_url: string | null;
  /** Google トレンド等の付帯指標 (検索ボリューム等) を JSON で保持。 */
  meta_json: string | null;
  published_at: string | null;
  ai_score: number | null;      // 0.0 - 1.0
  ai_reason: string | null;
  ai_matched: string | null;    // マッチした興味テーマの label
  ai_status: RssAiStatus;
  starred: number;              // 0 | 1
  read_at: string | null;
  notified_at: string | null;
  fetched_at: string;
}

/** AI Feeds (Feedly Leo 相当) — ユーザの「興味テーマ」。 */
export interface RssInterestRow {
  id: number;
  label: string;
  prompt: string;
  weight: number;     // 0.0 - 2.0 程度。 スコアの重み付けに使う
  enabled: number;    // 0 | 1
  created_at: string;
}

/** parse.ts が XML から取り出す中立的な記事表現。 */
export interface ParsedArticle {
  guid: string;
  url: string;
  title: string;
  summary: string | null;
  author: string | null;
  imageUrl: string | null;
  publishedAt: string | null; // ISO 8601
  meta: Record<string, unknown> | null;
}

export interface ParsedFeed {
  title: string | null;
  siteUrl: string | null;
  description: string | null;
  articles: ParsedArticle[];
}
