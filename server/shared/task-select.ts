// 通知フィルタ → アクティブタスク選択。 Discord 通知と帰宅・出発通知で共用する。

import type BetterSqlite3 from 'better-sqlite3';
import { listTasks } from '../db.js';
import type { TaskRow } from '../db/types/task.js';

type Db = BetterSqlite3.Database;

export type DeadlineFilter = 'all' | 'due_today_or_overdue';

export interface TaskFilter {
  /** ["all"] = 全カテゴリ、 それ以外は登録カテゴリ名の集合 (いずれか含むタスク)。 */
  categories: string[];
  /** "due_today_or_overdue" = 今日締切 or 期限超過のみ、 "all" = 期限不問。 */
  deadline: DeadlineFilter;
}

/** UI / 保存値など任意入力を TaskFilter に矯正する。 */
export function normalizeTaskFilter(v: unknown): TaskFilter {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const cats = Array.isArray(o.categories)
    ? o.categories.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim())
    : [];
  const deadline: DeadlineFilter = o.deadline === 'all' ? 'all' : 'due_today_or_overdue';
  return { categories: cats.length ? cats : ['all'], deadline };
}

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
export function matchDeadline(task: TaskRow, deadline: DeadlineFilter, now: Date): boolean {
  if (deadline === 'all') return true;
  if (!task.due_at) return false;
  const due = new Date(task.due_at).getTime();
  if (!Number.isFinite(due)) return false;
  return due <= endOfTodayLocalMs(now);
}

/** filter に合致するアクティブ (todo/doing) タスクを返す。 */
export async function selectTasks(db: Db, filter: TaskFilter, now: Date = new Date()): Promise<TaskRow[]> {
  const active = [
    ...(await listTasks(db, { status: 'todo', kind: 'task', limit: 500 })),
    ...(await listTasks(db, { status: 'doing', kind: 'task', limit: 500 })),
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
