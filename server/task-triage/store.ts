// task-triage — task_triage_sessions / task_triage_decisions の読み書き。 SQL はここに閉じる。
// Spec: spec/feature/task-triage.md §データ

import type BetterSqlite3 from 'better-sqlite3';
import type {
  TaskTriageSession, TaskTriageDecision, TaskTriageDecisionKind, TaskTriageScope, TaskTriageSessionStatus,
} from './types.js';
import { TRIAGE_DECISION_KINDS } from './types.js';

type Db = BetterSqlite3.Database;

interface SessionDbRow {
  id: number;
  scope: string;
  task_ids: string;
  status: string;
  created_at: string;
  finished_at: string | null;
}

interface DecisionDbRow {
  id: number;
  session_id: number;
  task_id: number;
  decision: string;
  due_at: string | null;
  created_at: string;
}

function parseIds(json: string): number[] {
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return [...new Set(v.filter((x): x is number => Number.isSafeInteger(x) && x > 0))];
  } catch {
    return [];
  }
}

function rowToSession(r: SessionDbRow): TaskTriageSession {
  return {
    id: r.id,
    scope: 'undated' satisfies TaskTriageScope,
    task_ids: parseIds(r.task_ids),
    // Unknown/corrupt values must not reopen a session and authorize mutations.
    status: r.status === 'active' ? 'active' : 'finished',
    created_at: r.created_at,
    finished_at: r.finished_at,
  };
}

function rowToDecision(r: DecisionDbRow): TaskTriageDecision | null {
  if (!TRIAGE_DECISION_KINDS.includes(r.decision as TaskTriageDecisionKind)) return null;
  return {
    id: r.id,
    session_id: r.session_id,
    task_id: r.task_id,
    decision: r.decision as TaskTriageDecisionKind,
    due_at: r.due_at,
    created_at: r.created_at,
  };
}

const SESSION_COLS = 'id, scope, task_ids, status, created_at, finished_at';
const DECISION_COLS = 'id, session_id, task_id, decision, due_at, created_at';

export function insertTriageSession(db: Db, scope: TaskTriageScope, taskIds: number[]): number {
  const res = db.prepare(`INSERT INTO task_triage_sessions (scope, task_ids) VALUES (?, ?)`)
    .run(scope, JSON.stringify(taskIds));
  return Number(res.lastInsertRowid);
}

export function getTriageSession(db: Db, id: number): TaskTriageSession | null {
  const row = db.prepare(`SELECT ${SESSION_COLS} FROM task_triage_sessions WHERE id = ?`).get(id) as SessionDbRow | undefined;
  return row ? rowToSession(row) : null;
}

/** active なセッションは常に高々 1 件。 最新を返す。 */
export function getActiveTriageSession(db: Db): TaskTriageSession | null {
  const row = db.prepare(
    `SELECT ${SESSION_COLS} FROM task_triage_sessions WHERE status = 'active' ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get() as SessionDbRow | undefined;
  return row ? rowToSession(row) : null;
}

export function listTriageSessions(db: Db, limit = 20): TaskTriageSession[] {
  const rows = db.prepare(
    `SELECT ${SESSION_COLS} FROM task_triage_sessions ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(limit) as SessionDbRow[];
  return rows.map(rowToSession);
}

export function setTriageSessionStatus(db: Db, id: number, status: TaskTriageSessionStatus, finishedAt?: string | null): void {
  db.prepare(`UPDATE task_triage_sessions SET status = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?`)
    .run(status, finishedAt ?? null, id);
}

/** 同一 (session, task) は上書き (再判断)。 */
export function upsertTriageDecision(
  db: Db, sessionId: number, taskId: number, decision: TaskTriageDecisionKind, dueAt: string | null,
): void {
  db.prepare(`
    INSERT INTO task_triage_decisions (session_id, task_id, decision, due_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, task_id) DO UPDATE SET
      decision = excluded.decision,
      due_at = excluded.due_at,
      created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(sessionId, taskId, decision, dueAt);
}

export function listTriageDecisions(db: Db, sessionId: number): TaskTriageDecision[] {
  const rows = db.prepare(
    `SELECT ${DECISION_COLS} FROM task_triage_decisions WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
  ).all(sessionId) as DecisionDbRow[];
  return rows.map(rowToDecision).filter((row): row is TaskTriageDecision => row !== null);
}
