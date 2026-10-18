import type BetterSqlite3 from 'better-sqlite3';
import {
  getTask,
  insertTask,
  recordActivityEvent,
} from '../db.js';
import type { InsertTaskInput } from '../db.js';
import type { TaskRow } from '../db/types/task.js';
import { appendDiaryLine } from './diary-append.js';

type Db = BetterSqlite3.Database;

export async function registerTask(
  db: Db,
  input: InsertTaskInput,
  now: Date = new Date(),
): Promise<TaskRow> {
  const title = input.title.trim();
  if (!title) throw new Error('task title is required');

  const id = (await insertTask(db, { ...input, title }));
  const created = (await getTask(db, id));
  if (!created) throw new Error('failed to read inserted task');

  const label = created.kind === 'goal' ? '目標発行' : 'タスク発行';
  appendDiaryLine(
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
