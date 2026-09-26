// Only ID correspondence lives locally; task content and status belong to Actio.
import type BetterSqlite3 from 'better-sqlite3';
type Db = BetterSqlite3.Database;
const initialized = new WeakSet<Db>();

function initialize(db: Db): void {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS actio_task_ids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actio_id TEXT UNIQUE
  )`);
  // Reserve every legacy ID before assigning IDs to tasks created directly in Actio.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get()) {
    db.exec('INSERT OR IGNORE INTO actio_task_ids (id) SELECT id FROM tasks');
  }
  initialized.add(db);
}

export function localTaskId(db: Db, actioId: string, legacyId?: number): number {
  initialize(db);
  const existing = db.prepare('SELECT id FROM actio_task_ids WHERE actio_id = ?').get(actioId) as { id: number } | undefined;
  if (existing) return existing.id;
  if (legacyId !== undefined) {
    const reserved = db.prepare('SELECT actio_id FROM actio_task_ids WHERE id = ?').get(legacyId) as { actio_id: string | null } | undefined;
    if (reserved?.actio_id && reserved.actio_id !== actioId) throw new Error(`Conflicting Actio mapping for Memoria task ${legacyId}`);
    db.prepare('INSERT INTO actio_task_ids (id, actio_id) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET actio_id=excluded.actio_id').run(legacyId, actioId);
    return legacyId;
  }
  return Number(db.prepare('INSERT INTO actio_task_ids (actio_id) VALUES (?)').run(actioId).lastInsertRowid);
}

export function remoteTaskId(db: Db, id: number): string | undefined {
  initialize(db);
  return (db.prepare('SELECT actio_id FROM actio_task_ids WHERE id = ?').get(id) as { actio_id: string | null } | undefined)?.actio_id ?? undefined;
}
