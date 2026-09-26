import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { TaskRow } from '../db/types/task.js';
import type { InsertTaskInput, ListTasksOptions } from './sqlite.js';
import { ActioError, requestActio } from './client.js';
import { localTaskId, remoteTaskId } from './identity.js';
type Db = BetterSqlite3.Database;

interface ActioTask {
  id: string; title: string; description: string | null; status: string;
  kind: 'task' | 'goal'; creatorType: 'human' | 'ai'; deadline: string | null;
  category: string | null; createdAt: string; updatedAt: string;
  pluginId: string | null; pluginRef: string | null;
  pluginPayload?: { memoria?: Partial<TaskRow> } | null;
}

function toTask(db: Db, task: ActioTask): TaskRow {
  if (!task || typeof task.id !== 'string' || typeof task.title !== 'string') throw new Error('Invalid Actio task response');
  if (!['open', 'in_progress', 'blocked', 'done', 'cancelled'].includes(task.status)) throw new Error('Unknown Actio task status');
  const match = task.pluginId === 'memoria' ? /^memoria:(\d+)$/.exec(task.pluginRef ?? '') : null;
  const legacyId = match ? Number(match[1]) : undefined;
  if (legacyId !== undefined && (!Number.isSafeInteger(legacyId) || legacyId <= 0)) throw new Error('Invalid legacy task ID');
  const original = task.pluginPayload?.memoria;
  return {
    id: localTaskId(db, task.id, legacyId), title: task.title, details: task.description,
    status: task.status === 'open' ? 'todo' : ['in_progress', 'blocked'].includes(task.status) ? 'doing' : 'done',
    kind: task.kind, creator_type: task.creatorType, due_at: task.deadline,
    category: task.category, created_at: original?.created_at ?? task.createdAt, updated_at: task.updatedAt,
    share_actio: 1, shared_at: task.createdAt, shared_origin: 'actio',
  };
}

export async function listTasks(db: Db, options: ListTasksOptions = {}): Promise<TaskRow[]> {
  const query = new URLSearchParams({ kind: options.kind ?? 'task', scope: 'owned', sort: 'personal' });
  if (options.status) query.set('status', options.status);
  const result = await requestActio<{ tasks: ActioTask[] }>(`/api/tasks?${query}`);
  if (!Array.isArray(result.tasks)) throw new Error('Invalid Actio task list response');
  // Reserve imported IDs first, including when a fresh client has no legacy DB.
  for (const task of result.tasks) {
    if (task.pluginId === 'memoria' && /^memoria:\d+$/.test(task.pluginRef ?? '')) toTask(db, task);
  }
  const rows = result.tasks.map(task => toTask(db, task));
  const offset = Math.max(0, options.offset ?? 0);
  return rows.slice(offset, offset + Math.max(0, options.limit ?? 100));
}

async function resolveId(db: Db, id: number): Promise<string | undefined> {
  let remote = remoteTaskId(db, id);
  if (!remote) {
    await listTasks(db, { kind: 'all', limit: Number.MAX_SAFE_INTEGER });
    remote = remoteTaskId(db, id);
  }
  return remote;
}

export async function getTask(db: Db, id: number): Promise<TaskRow | undefined> {
  const remote = await resolveId(db, id);
  if (!remote) return undefined;
  try {
    const { task } = await requestActio<{ task: ActioTask }>(`/api/tasks/${encodeURIComponent(remote)}`);
    return toTask(db, task);
  } catch (error) {
    if (error instanceof ActioError && error.status === 404) return undefined;
    throw error;
  }
}

export async function insertTask(db: Db, input: InsertTaskInput): Promise<number> {
  const { task } = await requestActio<{ task: ActioTask }>('/api/tasks', 'POST', {
    ...input, source: 'memoria-import', sourceRef: input.source_ref ?? `request:${randomUUID()}`,
    pluginId: 'memoria',
  });
  return toTask(db, task).id;
}

export async function updateTask(db: Db, id: number, patch: Record<string, unknown>): Promise<void> {
  const remote = await resolveId(db, id);
  if (!remote) throw new Error(`Task ${id} not found in Actio`);
  const allowed = ['title', 'details', 'status', 'kind', 'creator_type', 'due_at', 'category'];
  const body = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key)));
  if (Object.keys(body).length) await requestActio(`/api/tasks/${encodeURIComponent(remote)}`, 'PATCH', body);
}

export async function deleteTask(db: Db, id: number): Promise<void> {
  const remote = await resolveId(db, id);
  if (!remote) throw new Error(`Task ${id} not found in Actio`);
  await requestActio(`/api/tasks/${encodeURIComponent(remote)}`, 'DELETE');
}

export async function listTaskCategories(_db: Db): Promise<string[]> {
  const result = await requestActio<{ items: string[] }>('/api/tasks/categories');
  if (!Array.isArray(result.items)) throw new Error('Invalid Actio category response');
  return result.items;
}

export async function registerTaskCategory(_db: Db, name: string): Promise<void> {
  await requestActio('/api/tasks/categories', 'POST', { name });
}

export async function unregisterTaskCategory(_db: Db, name: string): Promise<void> {
  await requestActio(`/api/tasks/categories/${encodeURIComponent(name)}`, 'DELETE');
}
