// task-review — 棚卸し対象の絞り込み (純関数)。
// 朝の棚卸しは「期限超過」だけを見る。 期限未設定は task-triage セッションで別途捌く。
// Spec: spec/feature/task-review.md §対象範囲

import type { TaskRow } from '../db/types/task.js';

/** 'overdue' = 期限超過のみ (朝の既定)。 'all' = 旧来どおり未完すべて (手動実行の明示指定用)。 */
export type TaskReviewScope = 'overdue' | 'all';

export function parseTaskReviewScope(raw: unknown): TaskReviewScope {
  return raw === 'all' ? 'all' : 'overdue';
}

/** due_at ('YYYY-MM-DDTHH:MM' local / ISO UTC) を Date に。 不正なら null。 */
export function parseDueAt(dueAt: string | null | undefined): Date | null {
  if (!dueAt) return null;
  const d = new Date(dueAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 期限が設定されていて、 now より前なら超過。 期限なし/不正は超過扱いしない。 */
export function isOverdueTask(task: Pick<TaskRow, 'due_at' | 'status'>, now: Date): boolean {
  if (task.status === 'done') return false;
  const due = parseDueAt(task.due_at);
  return !!due && due.getTime() < now.getTime();
}

/** 未完タスクから scope に応じた棚卸し対象を選ぶ。 入力順を保つ。 */
export function selectReviewTasks(tasks: TaskRow[], scope: TaskReviewScope, now: Date): TaskRow[] {
  const open = tasks.filter((t) => t.status !== 'done');
  if (scope === 'all') return open;
  return open.filter((t) => isOverdueTask(t, now));
}
