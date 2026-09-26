import type BetterSqlite3 from 'better-sqlite3';
import * as actio from './actio.js';
import * as sqlite from './sqlite.js';
import type { TaskRow } from '../db/types/task.js';
type Db = BetterSqlite3.Database;

function backend(): typeof actio | typeof sqlite {
  const selected = process.env.MEMORIA_TASK_BACKEND ?? 'actio';
  if (selected === 'actio') return actio;
  if (selected === 'sqlite') return sqlite;
  throw new Error(`Unknown MEMORIA_TASK_BACKEND: ${selected}`);
}

export async function listTasks(db: Db, options?: sqlite.ListTasksOptions): Promise<TaskRow[]> { return backend().listTasks(db, options); }
export async function getTask(db: Db, id: number): Promise<TaskRow | undefined> { return backend().getTask(db, id); }
export async function insertTask(db: Db, input: sqlite.InsertTaskInput): Promise<number> { return backend().insertTask(db, input); }
export async function updateTask(db: Db, id: number, patch: Record<string, unknown>): Promise<void> { await backend().updateTask(db, id, patch); }
export async function deleteTask(db: Db, id: number): Promise<void> { await backend().deleteTask(db, id); }
export async function listTaskCategories(db: Db): Promise<string[]> { return backend().listTaskCategories(db); }
export async function registerTaskCategory(db: Db, name: string): Promise<void> { await backend().registerTaskCategory(db, name); }
export async function unregisterTaskCategory(db: Db, name: string): Promise<void> { await backend().unregisterTaskCategory(db, name); }
