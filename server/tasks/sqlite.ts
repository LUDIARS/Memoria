// Explicit legacy backend for isolated tests and migration rollback.
import type BetterSqlite3 from 'better-sqlite3';
import type { TaskRow } from '../db/types/task.js';
type Db = BetterSqlite3.Database;

export interface ListTasksOptions {
  status?: TaskRow['status'] | null;
  /**
   * - 'task' | 'goal' : その kind だけ返す
   * - 'all'           : 両方
   * - null (既定)      : 'task' (= 通常タスク一覧、 目標は別 query で取る前提)
   */
  kind?: TaskRow['kind'] | 'all' | null;
  limit?: number;
  offset?: number;
}

export function listTasks(db: Db, { status = null, kind = null, limit = 100, offset = 0 }: ListTasksOptions = {}): TaskRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (status) {
    where.push('status = ?');
    args.push(status);
  }
  if (kind === null) {
    where.push(`kind = 'task'`);
  } else if (kind !== 'all') {
    where.push('kind = ?');
    args.push(kind);
  }
  args.push(limit, offset);
  return db.prepare(`
    SELECT * FROM tasks
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY
      CASE status WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
      COALESCE(due_at, '9999-12-31') ASC,
      created_at DESC
    LIMIT ? OFFSET ?
  `).all(...args) as TaskRow[];
}

export function getTask(db: Db, id: number): TaskRow | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
}

export interface InsertTaskInput {
  /** Stable request key for callers such as Alexa; Actio enforces uniqueness. */
  source_ref?: string;
  title: string;
  details?: string | null;
  status?: TaskRow['status'];
  kind?: TaskRow['kind'];
  creator_type?: TaskRow['creator_type'];
  due_at?: string | null;
  share_actio?: boolean | 0 | 1;
  category?: string | null;
}

export function insertTask(db: Db, task: InsertTaskInput): number {
  const info = db.prepare(`
    INSERT INTO tasks (title, details, status, kind, creator_type, due_at, share_actio, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.title,
    task.details ?? null,
    task.status || 'todo',
    task.kind === 'goal' ? 'goal' : 'task',
    task.creator_type === 'ai' ? 'ai' : 'human',
    task.due_at ?? null,
    task.share_actio ? 1 : 0,
    task.category ?? null,
  );
  return Number(info.lastInsertRowid);
}

/**
 * Distinct categories from tasks + manually registered ones (stored in
 * app_settings as JSON `task.categories.registered`). Merged + deduped +
 * sorted ascending. Manually-registered ones can have 0 tasks attached
 * (they show up in the side menu so users can pre-create categories).
 *
 * 1 タスクは複数カテゴリを持てる。 `tasks.category` カラムには **カンマ区切り**
 * で保存する (`"開発, 学習"` のように)。 ここでは split + flatten + 重複排除する。
 */
export function listTaskCategories(db: Db): string[] {
  const rows = db.prepare(`
    SELECT category
    FROM tasks
    WHERE category IS NOT NULL AND category != ''
      AND status IN ('todo', 'doing')
  `).all() as { category: string | null }[];
  const fromTasks = new Set<string>();
  for (const row of rows) {
    for (const c of String(row.category || '').split(',')) {
      const t = c.trim();
      if (t) fromTasks.add(t);
    }
  }
  let registered: string[] = [];
  try {
    const raw = db.prepare(`SELECT value FROM app_settings WHERE key = ?`)
      .get('task.categories.registered') as { value: string | null } | undefined;
    if (raw?.value) registered = (JSON.parse(raw.value) as string[]) || [];
  } catch { /* ignore */ }
  const all = new Set<string>([...fromTasks]);
  for (const c of registered) if (c) all.add(c);
  return [...all].sort((a, b) => a.localeCompare(b));
}

export function registerTaskCategory(db: Db, name: string): void {
  const n = String(name || '').trim();
  if (!n) return;
  let registered: string[] = [];
  try {
    const raw = db.prepare(`SELECT value FROM app_settings WHERE key = ?`)
      .get('task.categories.registered') as { value: string | null } | undefined;
    if (raw?.value) registered = (JSON.parse(raw.value) as string[]) || [];
  } catch { /* ignore */ }
  if (!registered.includes(n)) {
    registered.push(n);
    db.prepare(`
      INSERT INTO app_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('task.categories.registered', JSON.stringify(registered));
  }
}

export function unregisterTaskCategory(db: Db, name: string): void {
  const n = String(name || '').trim();
  if (!n) return;
  let registered: string[] = [];
  try {
    const raw = db.prepare(`SELECT value FROM app_settings WHERE key = ?`)
      .get('task.categories.registered') as { value: string | null } | undefined;
    if (raw?.value) registered = (JSON.parse(raw.value) as string[]) || [];
  } catch { /* ignore */ }
  const next = registered.filter(c => c !== n);
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run('task.categories.registered', JSON.stringify(next));
}

export function updateTask(db: Db, id: number, patch: Record<string, unknown>): void {
  const allowed = new Set(['title', 'details', 'status', 'kind', 'creator_type', 'due_at', 'share_actio', 'shared_at', 'shared_origin', 'category']);
  const cols: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    cols.push(`${k} = ?`);
    args.push(k === 'share_actio' ? (v ? 1 : 0) : v);
  }
  if (!cols.length) return;
  cols.push(`updated_at = datetime('now')`);
  args.push(id);
  db.prepare(`UPDATE tasks SET ${cols.join(', ')} WHERE id = ?`).run(...args);
}

export function deleteTask(db: Db, id: number): void {
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
}
