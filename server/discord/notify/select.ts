// 通知フィルタ → アクティブタスク選択。 純粋ロジック (テスト対象)。

import type BetterSqlite3 from 'better-sqlite3';
import { listTasks } from '../../db.js';
import type { TaskRow } from '../../db/types/task.js';
import type { NotifyFilter } from './types.js';

type Db = BetterSqlite3.Database;

/** tasks.category (カンマ区切り) を配列に。 */
export function parseCategories(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/** カテゴリフィルタ: ["all"] / 空 は常に一致、 それ以外は交差ありで一致。 */
export function matchCategory(task: TaskRow, categories: string[]): boolean {
  if (!categories.length || categories.includes('all')) return true;
  const taskCats = parseCategories(task.category);
  return taskCats.some((c) => categories.includes(c));
}

/** その日のローカル末尾 (23:59:59.999) の epoch ms。 */
function endOfTodayLocalMs(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
}

/**
 * 期限フィルタ。 "all" は不問。 "due_today_or_overdue" は due_at が
 * 「ローカル今日の終わり以前」 (= 今日締切 or 期限超過) のものだけ。
 * due_at は UTC ISO ('...Z') か local 'YYYY-MM-DDTHH:MM' のどちらも来うるが、
 * どちらも new Date() で正しく解釈できる (前者=UTC, 後者=ローカル)。
 */
export function matchDeadline(task: TaskRow, deadline: NotifyFilter['deadline'], now: Date): boolean {
  if (deadline === 'all') return true;
  if (!task.due_at) return false;
  const due = new Date(task.due_at).getTime();
  if (!Number.isFinite(due)) return false;
  return due <= endOfTodayLocalMs(now);
}

/** filter に合致するアクティブ (todo/doing) タスクを返す。 */
export function selectTasks(db: Db, filter: NotifyFilter, now: Date = new Date()): TaskRow[] {
  const active = [
    ...listTasks(db, { status: 'todo', kind: 'task', limit: 500 }),
    ...listTasks(db, { status: 'doing', kind: 'task', limit: 500 }),
  ];
  return active
    .filter((t) => matchCategory(t, filter.categories) && matchDeadline(t, filter.deadline, now))
    .sort((a, b) => dueRank(a) - dueRank(b));
}

/** 期限が近い順。 due_at 無しは末尾。 */
function dueRank(t: TaskRow): number {
  if (!t.due_at) return Number.MAX_SAFE_INTEGER;
  const v = new Date(t.due_at).getTime();
  return Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER;
}
