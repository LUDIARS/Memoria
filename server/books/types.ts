// 本棚ドメインの型。 Spec: spec/feature/books.md
//
// 3 つの機能を 1 ドメインで扱う。
//   1. 良かった本のリスト   — books テーブル (手入力 / インポート)
//   2. 新刊チェック         — 良かった本から著者・シリーズを拾って週 1 で巡回
//   3. 人気の本サジェスト   — LLM 推薦 + 楽天売れ筋 + Google Books 評価

/** 書誌の取得元。 `manual` は手入力、 `import` は CSV / My Clippings 取り込み。 */
export type BookSourceKind = 'google_books' | 'openbd' | 'ndl' | 'rakuten' | 'manual' | 'import';

/** 新刊ウォッチの単位。 良かった本から自動導出する。 */
export type WatchKind = 'author' | 'series';

/** サジェストの根拠。 neco の指定で 3 系統。 */
export type SuggestionOrigin = 'llm' | 'rakuten_ranking' | 'google_rating';

/** 蔵書 1 冊 (SQLite row そのまま。 authors / tags は JSON 文字列)。 */
export interface BookRow {
  id: number;
  isbn13: string | null;
  asin: string | null;
  title: string;
  /** 正規化タイトル。 重複判定・所持判定に使う。 */
  title_key: string;
  authors_json: string;
  publisher: string | null;
  series: string | null;
  published_on: string | null;   // YYYY-MM-DD (日付不明なら YYYY-MM / YYYY)
  /** 1〜5。 未評価は null。 config.watchMinRating 以上を「良かった本」として扱う。 */
  rating: number | null;
  review: string | null;
  tags_json: string;
  read_on: string | null;        // YYYY-MM-DD
  cover_url: string | null;
  source: BookSourceKind;
  created_at: string;            // UTC ISO
  updated_at: string;            // UTC ISO
}

/** アプリ側で扱う蔵書 (JSON 列を配列に開いたもの)。 */
export interface Book {
  id: number;
  isbn13: string | null;
  asin: string | null;
  title: string;
  authors: string[];
  publisher: string | null;
  series: string | null;
  publishedOn: string | null;
  rating: number | null;
  review: string | null;
  tags: string[];
  readOn: string | null;
  coverUrl: string | null;
  source: BookSourceKind;
  createdAt: string;
  updatedAt: string;
}

/** 登録・更新の入力。 id 以外はすべて任意 (title だけ必須)。 */
export interface BookInput {
  isbn13?: string | null;
  asin?: string | null;
  title: string;
  authors?: string[];
  publisher?: string | null;
  series?: string | null;
  publishedOn?: string | null;
  rating?: number | null;
  review?: string | null;
  tags?: string[];
  readOn?: string | null;
  coverUrl?: string | null;
  source?: BookSourceKind;
}

/** 外部ソースから取れた書誌 1 件 (正規化済み)。 */
export interface BookCandidate {
  isbn13: string | null;
  title: string;
  authors: string[];
  publisher: string | null;
  series: string | null;
  publishedOn: string | null;
  coverUrl: string | null;
  url: string | null;
  source: BookSourceKind;
  /** Google Books の平均評価 (0〜5)。 取れないソースは null。 */
  rating: number | null;
  ratingCount: number | null;
  /** 楽天売れ筋順の順位 (1 始まり)。 ランキング由来でなければ null。 */
  salesRank: number | null;
}

/** 新刊ウォッチ対象。 books から導出するので永続化しない。 */
export interface WatchTarget {
  kind: WatchKind;
  value: string;
  /** 手持ちの該当冊数 (多い順に巡回する)。 */
  bookCount: number;
  /** 手持ちの最高評価。 */
  topRating: number;
}

/** 検知した新刊 (row)。 */
export interface NewReleaseRow {
  id: number;
  watch_kind: WatchKind;
  watch_value: string;
  isbn13: string | null;
  title: string;
  title_key: string;
  authors_json: string;
  publisher: string | null;
  published_on: string | null;
  url: string | null;
  cover_url: string | null;
  source: BookSourceKind;
  found_at: string;
  notified_at: string | null;
  dismissed_at: string | null;
}

export interface NewRelease {
  id: number;
  watchKind: WatchKind;
  watchValue: string;
  isbn13: string | null;
  title: string;
  authors: string[];
  publisher: string | null;
  publishedOn: string | null;
  url: string | null;
  coverUrl: string | null;
  source: BookSourceKind;
  foundAt: string;
  notifiedAt: string | null;
  dismissedAt: string | null;
}

/** サジェスト候補 (row)。 */
export interface SuggestionRow {
  id: number;
  isbn13: string | null;
  title: string;
  title_key: string;
  authors_json: string;
  publisher: string | null;
  published_on: string | null;
  url: string | null;
  cover_url: string | null;
  origin: SuggestionOrigin;
  /** 推薦理由 (LLM の一言 / 「楽天 売れ筋 3 位」 など)。 */
  reason: string;
  rating: number | null;
  rating_count: number | null;
  sales_rank: number | null;
  /** 並べ替え用の総合スコア (大きいほど上)。 */
  score: number;
  generated_at: string;
  dismissed_at: string | null;
}

export interface Suggestion {
  id: number;
  isbn13: string | null;
  title: string;
  authors: string[];
  publisher: string | null;
  publishedOn: string | null;
  url: string | null;
  coverUrl: string | null;
  origin: SuggestionOrigin;
  reason: string;
  rating: number | null;
  ratingCount: number | null;
  salesRank: number | null;
  score: number;
  generatedAt: string;
  dismissedAt: string | null;
}

/** 使う書誌ソースの ON/OFF。 楽天だけアプリ ID が要る。 */
export interface BooksSourceToggles {
  googleBooks: boolean;
  openbd: boolean;
  ndl: boolean;
  rakuten: boolean;
}

export interface BooksConfig {
  defaultsVersion: number;
  enabled: boolean;
  /** 週次巡回の曜日 (0 = 日)。 */
  weeklyDay: number;
  weeklyHour: number;
  /** この評価以上を 「良かった本」 として新刊ウォッチ・サジェストの土台にする。 */
  watchMinRating: number;
  /** 1 回の巡回で見るウォッチ対象の上限。 */
  maxWatchTargets: number;
  /** 新刊とみなす発売日の範囲 (今日から前後何日)。 */
  newReleaseLookbackDays: number;
  newReleaseLookaheadDays: number;
  /** 保存するサジェストの件数。 */
  suggestionCount: number;
  /** 楽天ブックス API のアプリ ID。 未設定なら楽天ソースは自動的に無効。 */
  rakutenApplicationId: string;
  sources: BooksSourceToggles;
}
