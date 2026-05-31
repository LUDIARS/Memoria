// dig domain — dig_sessions / recommendation_dismissals
// Spec: spec/data/dig.md

export type DigStatus = 'pending' | 'done' | 'error';

export interface DigSessionRow {
  id: number;
  query: string;
  created_at: string;        // UTC ISO
  status: DigStatus;
  error: string | null;
  result_json: string | null;     // JSON string — Phase-2 deep result
  preview_json: string | null;    // JSON string — Phase-1 preview
  raw_results_json: string | null;// JSON string — Phase-0 raw SERP
  theme: string | null;           // optional caller-supplied theme
  // multi-server (Hub) 連携
  owner_user_id: string | null;
  owner_user_name: string | null;
  shared_at: string | null;
  shared_origin: string | null;
  // レビュー画面発の dig は出自を持つ (= レビュータブ末尾で履歴再表示用)。
  // 通常 dig タブ起動の場合は全部 null。
  origin_kind: 'review' | null;
  origin_repo: string | null;
  origin_date: string | null;
  origin_file: string | null;
}

export interface RecommendationDismissalRow {
  url: string;
  dismissed_at: string;
}
