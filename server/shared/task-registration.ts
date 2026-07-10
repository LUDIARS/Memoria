import type BetterSqlite3 from 'better-sqlite3';
import {
  getDiary,
  getTask,
  insertTask,
  recordActivityEvent,
  upsertDiary,
} from '../db.js';
import type { InsertTaskInput } from '../db.js';
import type { TaskRow } from '../db/types/task.js';

type Db = BetterSqlite3.Database;

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

export function registerTask(
  db: Db,
  input: InsertTaskInput,
  now: Date = new Date(),
): TaskRow {
  const title = input.title.trim();
  if (!title) throw new Error('task title is required');

  const id = insertTask(db, { ...input, title });
  const created = getTask(db, id);
  if (!created) throw new Error('failed to read inserted task');

  const label = created.kind === 'goal' ? '目標発行' : 'タスク発行';
  appendTaskDiaryLog(
    db,
    `${label}: ${created.title}${created.due_at ? ` (期限: ${created.due_at})` : ''}`,
    now,
  );
  recordActivityEvent(db, {
    kind: created.kind === 'goal' ? 'goal_created' : 'task_created',
    occurred_at: now.toISOString(),
    content: created.title,
    metadata: created.due_at ? { due_at: created.due_at } : undefined,
  });
  return created;
}
