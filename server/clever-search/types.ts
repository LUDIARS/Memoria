export const CLEVER_SEARCH_CATEGORIES = [
  'development',
  'conversation',
  'knowledge',
  'reflection',
  'action',
] as const;

export type CleverSearchCategory = typeof CLEVER_SEARCH_CATEGORIES[number];

export const CLEVER_SEARCH_CATEGORY_LABELS: Record<CleverSearchCategory, string> = {
  development: '開発・活動ログ',
  conversation: '会話ログ',
  knowledge: '知識・調査',
  reflection: '日記・振り返り',
  action: 'タスク・改善記録',
};

export interface CleverSearchDocumentRow {
  id: number;
  source_type: string;
  source_id: string;
  report_category: CleverSearchCategory;
  title: string;
  content: string;
  occurred_at: string;
  source_subtype: string | null;
}

export interface CleverSearchHit extends CleverSearchDocumentRow {
  score: number;
}

export interface CleverSearchCitation {
  sourceType: string;
  sourceId: string;
  sourceSubtype: string | null;
  title: string;
  occurredAt: string;
  excerpt: string;
  score: number;
}

export interface CleverSearchCategoryReport {
  key: CleverSearchCategory;
  label: string;
  count: number;
  summary: string;
  firstOccurredAt: string;
  lastOccurredAt: string;
  sourceBreakdown: Array<{ sourceType: string; count: number }>;
  representatives: CleverSearchCitation[];
  citations: CleverSearchCitation[];
}

export interface CleverSearchTimelineBucket {
  month: string;
  count: number;
}

export interface CleverSearchReport {
  version: 1;
  query: string;
  normalizedQuery: string;
  totalHits: number;
  summary: string;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  categories: CleverSearchCategoryReport[];
  timeline: CleverSearchTimelineBucket[];
  createdAt: string;
  searchElapsedMs: number;
}

export interface StoredCleverSearchReport {
  id: number;
  query: string;
  normalized_query: string;
  total_hits: number;
  report_json: string;
  search_elapsed_ms: number;
  created_at: string;
}
