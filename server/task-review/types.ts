// task-review domain — 型定義 (TaskReview / 提案 / スナップショット衝突)。
// Spec: spec/feature/task-review.md

export type TaskReviewKind = 'cluster' | 'completed';
export type TaskReviewStatus = 'pending' | 'applied' | 'dismissed';

/** 生成時に記録する対象タスクのスナップショット 1 件 (存在/変更検知に使う)。 */
export interface TaskSnapshotEntry {
  id: number;
  title: string;
  status: string;
}

/** task_reviews 1 行 (task_ids / snapshot は JSON parse 済み)。 */
export interface TaskReview {
  id: number;
  kind: TaskReviewKind;
  project: string | null;
  task_ids: number[];
  primary_id: number | null;
  reason: string;
  snapshot: TaskSnapshotEntry[];
  status: TaskReviewStatus;
  for_date: string | null;
  created_at: string;
  applied_at: string | null;
}

export interface InsertTaskReviewInput {
  kind: TaskReviewKind;
  project?: string | null;
  task_ids: number[];
  primary_id?: number | null;
  reason: string;
  snapshot: TaskSnapshotEntry[];
  for_date?: string | null;
}

// ── LLM (task_review) が返す提案の形 ──────────────────────────────────────────

/** 同一プロジェクト内の近い/重複タスクのクラスタ。 primary_id に統合する。 */
export interface ClusterSuggestion {
  project?: string | null;
  task_ids: number[];
  primary_id?: number;
  reason: string;
}

/** 完了していそうなタスク 1 件。 */
export interface CompletedSuggestion {
  task_id: number;
  reason: string;
}

export interface TaskReviewSuggestions {
  clusters: ClusterSuggestion[];
  completed: CompletedSuggestion[];
}

// ── 圧縮前の存在/変更ガード ───────────────────────────────────────────────────

/** スナップショットと現状の不一致 1 件。 missing=消滅 / changed=title or status が変化。 */
export interface SnapshotConflict {
  id: number;
  kind: 'missing' | 'changed';
}
