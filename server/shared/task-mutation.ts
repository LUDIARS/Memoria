// タスク更新に伴う所有者変更・日記・活動ログを一箇所で適用する。
// Spec: spec/feature/task.md / spec/feature/task-triage.md §セッション

import type BetterSqlite3 from 'better-sqlite3';
import {
  getDiary,
  getTask,
  recordActivityEvent,
  updateTask,
  upsertDiary,
} from '../db.js';
import type { TaskRow } from '../db/types/task.js';

type Db = BetterSqlite3.Database;

export interface TaskMutationResult {
  before: TaskRow;
  after: TaskRow;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function appendTaskDiaryLog(db: Db, line: string, now: Date): void {
  const date = formatLocalDate(now);
  const row = getDiary(db, date);
  const previous = String(row?.notes ?? '').trimEnd();
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const next = previous ? `${previous}\n${hour}:${minute} ${line}` : `${hour}:${minute} ${line}`;
  upsertDiary(db, { date, notes: next, status: row?.status ?? 'pending' });
}

/** UI/API の経路に依存せず、タスク更新とその監査上の副作用を一体で適用する。 */
export function updateTaskWithJournal(
  db: Db,
  id: number,
  inputPatch: Record<string, unknown>,
  now: Date = new Date(),
): TaskMutationResult | null {
  const before = getTask(db, id);
  if (!before) return null;

  const patch = { ...inputPatch };
  if (before.creator_type === 'ai' && Object.hasOwn(patch, 'due_at') && patch.due_at !== before.due_at) {
    patch.creator_type = 'human';
  }
  updateTask(db, id, patch);

  const after = getTask(db, id);
  if (!after) throw new Error('task disappeared after update');
  const isGoal = after.kind === 'goal';
  const noun = isGoal ? '目標' : 'タスク';
  const completedNow = before.status !== 'done' && after.status === 'done';
  if (completedNow) {
    appendTaskDiaryLog(db, `${noun}完了: ${after.title}`, now);
    recordActivityEvent(db, {
      kind: isGoal ? 'goal_done' : 'task_done',
      occurred_at: now.toISOString(),
      content: after.title,
    });
  } else {
    const changed = ['title', 'details', 'status', 'due_at', 'share_actio', 'kind']
      .some((key) => Object.hasOwn(patch, key));
    const isHumanChange = before.creator_type === 'human'
      || (before.creator_type === 'ai' && after.creator_type === 'human');
    if (changed && isHumanChange) {
      appendTaskDiaryLog(db, `${noun}更新: ${after.title}${after.due_at ? ` (期日: ${after.due_at})` : ''}`, now);
      recordActivityEvent(db, {
        kind: isGoal ? 'goal_updated' : 'task_updated',
        occurred_at: now.toISOString(),
        content: after.title,
        metadata: patch.status ? { status: after.status } : undefined,
      });
    }
  }
  return { before, after };
}
