// task-triage domain — 期限未設定タスクをセッション形式で捌くための型。
// Spec: spec/feature/task-triage.md

import type { TaskRow } from '../db/types/task.js';

/** いまは 'undated' (期限未設定) のみ。 将来 'stale' 等を足せるように文字列で持つ。 */
export type TaskTriageScope = 'undated';

export type TaskTriageSessionStatus = 'active' | 'finished';

/**
 * 1 タスクへの判断。
 * - due   : 期限を設定する (due_at 必須)
 * - done  : 完了として閉じる
 * - keep  : 意図的に期限なしのまま置く (棚卸し済み扱い)
 * - later : いまは判断しない。 セッション内で後回しにし、 未判断が尽きたら再提示する
 */
export type TaskTriageDecisionKind = 'due' | 'done' | 'keep' | 'later';

export const TRIAGE_DECISION_KINDS: readonly TaskTriageDecisionKind[] = ['due', 'done', 'keep', 'later'];

export interface TaskTriageSession {
  id: number;
  scope: TaskTriageScope;
  /** セッション開始時に集めた対象タスク id (提示順)。 */
  task_ids: number[];
  status: TaskTriageSessionStatus;
  created_at: string;
  finished_at: string | null;
}

export interface TaskTriageDecision {
  id: number;
  session_id: number;
  task_id: number;
  decision: TaskTriageDecisionKind;
  due_at: string | null;
  created_at: string;
}

export interface TaskTriageProgress {
  total: number;
  /** 最終判断 (due/done/keep) 済み + 外部で解決済み (完了/期限付与された) の件数。 */
  decided: number;
  /** later で後回し中の件数。 */
  deferred: number;
  /** 未判断 (later 含む) の件数。 */
  remaining: number;
  /** 判断種別ごとの件数 (セッション内)。 */
  counts: Record<TaskTriageDecisionKind, number>;
}

/** API が返すセッション状態 1 式。 batch は次に判断すべきタスク (最大 batchSize 件)。 */
export interface TaskTriageState {
  session: TaskTriageSession;
  progress: TaskTriageProgress;
  batch: TaskRow[];
}

/** LLM (task_triage) が返す 1 タスク分の提案。 */
export interface TaskTriageSuggestion {
  task_id: number;
  action: 'due' | 'done' | 'keep';
  /** action='due' のとき、 今日から何日後を期限にするか (1〜90)。 */
  due_in_days?: number;
  /** サーバ側で due_in_days から起こした 'YYYY-MM-DDTHH:MM' (local)。 */
  due_at?: string;
  reason: string;
}
