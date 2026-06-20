// ai-hub domain — 型定義 (AiArticle / AiSeed / AiAdvice / TopicCandidate)
// Spec: spec/feature/ai-hub.md

/** 記事の出所 1 件 (どの作業から派生したか)。 source_refs に JSON 配列で格納。 */
export interface SourceRef {
  kind: string;            // 'git_commit' | 'claude_code_prompt' | 'session_log' 等
  ref: string;             // commit sha / prompt uuid / 任意の参照
  repo?: string | null;    // リポ名 (あれば)
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
  note_id: string | null;          // 転写先 note.id (UUID)。 NULL=未転写
  created_at: string;
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
