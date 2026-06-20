// ai-hub domain — 型定義 (AiArticle / AiSeed / AiAdvice / TopicCandidate)
// Spec: spec/feature/ai-hub.md

/** 記事の出所 1 件 (どの作業から派生したか)。 source_refs に JSON 配列で格納。 */
export interface SourceRef {
  kind: string;            // 'git_commit' | 'claude_code_prompt' | 'session_log' 等
  ref: string;             // commit sha / prompt uuid / 任意の参照
  repo?: string | null;    // リポ名 (あれば)
}

/**
 * 記事タグの分類軸。 ユーザ指定の 4 軸 + その他。 日付 × タグでフィルタするため、
 * 値は category ごとに自由文字列 (言語=TypeScript / プロジェクト=Memoria 等)。
 */
export const TAG_CATEGORIES = ['言語', 'プロジェクト', '内容タイプ', '技術領域', 'その他'] as const;
export type TagCategory = (typeof TAG_CATEGORIES)[number];

/** 記事タグ 1 件。 ai_articles.tags に JSON 配列で格納。 */
export interface ArticleTag {
  category: string;        // TAG_CATEGORIES のいずれか (将来の追加に備え string)
  value: string;           // 'TypeScript' / 'Memoria' / '開発' / 'ネットワーク' 等
}

/** ai_articles 1 行。 source_refs は JSON parse 済みの配列で返す。 */
export interface AiArticle {
  id: number;
  title: string;
  body_md: string;
  topic_key: string | null;
  source_refs: SourceRef[];
  origin: 'digest' | 'requested' | string;
  for_date: string | null;
  tags: ArticleTag[];              // 言語/プロジェクト/内容タイプ/技術領域/その他
  note_id: string | null;          // 転写先 note.id (UUID)。 NULL=未転写
  created_at: string;
}

/** listAiArticles のフィルタ条件。 日付範囲 (for_date) + タグ AND 絞り込み。 */
export interface AiArticleFilter {
  limit?: number;
  from?: string | null;            // for_date >= from (YYYY-MM-DD)
  to?: string | null;              // for_date <= to (YYYY-MM-DD)
  tags?: ArticleTag[];             // すべて満たす記事のみ (AND)。 category+value 一致
}

/** 記事タグの集計 1 件 (フィルタ chips 用)。 */
export interface ArticleTagCount {
  category: string;
  value: string;
  count: number;
}

/** ai_article_seeds 1 行。 source_refs は JSON parse 済み。 */
export interface AiSeed {
  id: number;
  title: string;
  summary: string | null;
  angle: string | null;
  source_refs: SourceRef[];
  for_date: string | null;
  status: 'pending' | 'requested' | 'done' | 'dismissed' | string;
  article_id: number | null;
  created_at: string;
}

/** ai_advice 1 行。 data_summary は JSON parse 済み (投入データの件数等)。 */
export interface AiAdvice {
  id: number;
  for_date: string;
  body_md: string;
  data_summary: Record<string, unknown> | null;
  created_at: string;
}

/** article_topics LLM が返すトピック候補。 上位 N 本が本記事化される。 */
export interface TopicCandidate {
  title: string;
  summary: string;          // なぜ記事になるか
  angle: string;            // 提案アングル
  topicKey: string;         // 重複排除キー (repo:theme 等)
  sourceRefs: SourceRef[];
}

/** runDigest の戻り値。 */
export interface DigestResult {
  articles: AiArticle[];
  seeds: AiSeed[];
}
