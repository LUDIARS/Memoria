// task-triage — セッションの進行 (開始/再開、 次バッチの算出、 判断の適用、 終了)。
// 対象は「期限未設定 (due_at NULL) の未完タスク」。 セッション開始時に id を固定し、
// 判断ごとにタスク本体へ反映 (due_at 設定 / done) してから決定を記録する。
// Spec: spec/feature/task-triage.md §セッション

import type BetterSqlite3 from 'better-sqlite3';
import { listTasks, getTask } from '../db.js';
import type { TaskRow } from '../db/types/task.js';
import { updateTaskWithJournal } from '../shared/task-mutation.js';
import {
  getActiveTriageSession, getTriageSession, insertTriageSession, listTriageDecisions,
  setTriageSessionStatus, upsertTriageDecision,
} from './store.js';
import type {
  TaskTriageDecisionKind, TaskTriageProgress, TaskTriageSession, TaskTriageState,
} from './types.js';

type Db = BetterSqlite3.Database;

export const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 50;
const FETCH_LIMIT = 10_000;

export function clampBatchSize(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BATCH_SIZE;
  return Math.min(MAX_BATCH_SIZE, Math.floor(n));
}

/** 期限未設定の未完タスクを「カテゴリ → 作成日昇順」で並べる (純関数)。 古いものから捌く。 */
export function orderUndatedTasks(tasks: TaskRow[]): TaskRow[] {
  return tasks
    .filter((t) => t.status !== 'done' && !t.due_at)
    .sort((a, b) => {
      const ca = (a.category ?? '').split(',')[0].trim();
      const cb = (b.category ?? '').split(',')[0].trim();
      if (ca !== cb) return ca.localeCompare(cb, 'ja');
      return a.created_at.localeCompare(b.created_at) || a.id - b.id;
    });
}

/** 期限未設定の未完タスク件数 (セッション開始前の表示用)。 */
export function countUndatedTasks(db: Db): number {
  return orderUndatedTasks(listTasks(db, { kind: 'task', limit: FETCH_LIMIT })).length;
}

/**
 * 次に判断すべきタスクを選ぶ (純関数)。
 * 1. 判断なし → 2. later で後回し の順。 いずれも現時点で「未完かつ期限なし」のものだけ。
 * (セッション外で完了/期限付与されたタスクは解決済みとして飛ばす)
 */
export function pickBatch(
  session: TaskTriageSession,
  decisions: Map<number, TaskTriageDecisionKind>,
  current: Map<number, TaskRow | undefined>,
  batchSize: number,
): TaskRow[] {
  const stillOpen = (id: number): TaskRow | null => {
    const t = current.get(id);
    return t && t.status !== 'done' && !t.due_at ? t : null;
  };
  const fresh: TaskRow[] = [];
  const deferred: TaskRow[] = [];
  for (const id of session.task_ids) {
    const t = stillOpen(id);
    if (!t) continue;
    const d = decisions.get(id);
    if (!d) fresh.push(t);
    else if (d === 'later') deferred.push(t);
  }
  return [...fresh, ...deferred].slice(0, batchSize);
}

/** 進捗を数える (純関数)。 */
export function computeProgress(
  session: TaskTriageSession,
  decisions: Map<number, TaskTriageDecisionKind>,
  current: Map<number, TaskRow | undefined>,
): TaskTriageProgress {
  const counts: Record<TaskTriageDecisionKind, number> = { due: 0, done: 0, keep: 0, later: 0 };
  for (const d of decisions.values()) counts[d]++;
  let remaining = 0;
  let deferred = 0;
  for (const id of session.task_ids) {
    const t = current.get(id);
    const open = !!t && t.status !== 'done' && !t.due_at;
    if (!open) continue;                  // 外部解決 or 判断反映済み → decided 側
    const d = decisions.get(id);
    if (d === 'due' || d === 'done' || d === 'keep') continue;
    remaining++;
    if (d === 'later') deferred++;
  }
  const total = session.task_ids.length;
  return { total, decided: total - remaining, deferred, remaining, counts };
}

function loadCurrent(db: Db, ids: number[]): Map<number, TaskRow | undefined> {
  const m = new Map<number, TaskRow | undefined>();
  for (const id of ids) m.set(id, getTask(db, id));
  return m;
}

function decisionMap(db: Db, sessionId: number): Map<number, TaskTriageDecisionKind> {
  const m = new Map<number, TaskTriageDecisionKind>();
  for (const d of listTriageDecisions(db, sessionId)) m.set(d.task_id, d.decision);
  return m;
}

export function buildState(db: Db, session: TaskTriageSession, batchSize = DEFAULT_BATCH_SIZE): TaskTriageState {
  const decisions = decisionMap(db, session.id);
  const current = loadCurrent(db, session.task_ids);
  return {
    session,
    progress: computeProgress(session, decisions, current),
    batch: session.status === 'active' ? pickBatch(session, decisions, current, batchSize) : [],
  };
}

export function getCurrentState(db: Db, batchSize = DEFAULT_BATCH_SIZE): TaskTriageState | null {
  const session = getActiveTriageSession(db);
  return session ? buildState(db, session, batchSize) : null;
}

/**
 * セッションを開始する。 active があればそれを返す (再開)。 restart=true なら active を
 * finished にして新しく対象を集め直す。
 */
export function startSession(db: Db, opts: { restart?: boolean; batchSize?: number } = {}): TaskTriageState {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const active = getActiveTriageSession(db);
  if (active && !opts.restart) return buildState(db, active, batchSize);
  if (active) setTriageSessionStatus(db, active.id, 'finished', new Date().toISOString());

  const ids = orderUndatedTasks(listTasks(db, { kind: 'task', limit: FETCH_LIMIT })).map((t) => t.id);
  const id = insertTriageSession(db, 'undated', ids);
  const session = getTriageSession(db, id);
  if (!session) throw new Error('failed to create triage session');
  return buildState(db, session, batchSize);
}

export type DecideResult =
  | { ok: true; state: TaskTriageState }
  | { ok: false; code: 'not_found' | 'not_active' | 'not_in_session' | 'invalid' | 'conflict'; error: string };

/** 'YYYY-MM-DD' または 'YYYY-MM-DDTHH:MM' を受け、 日付だけなら 18:00 を補う。 それ以外は null。 */
export function normalizeDueAt(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(s);
  if (!match) return null;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = hourRaw === undefined ? 18 : Number(hourRaw);
  const minute = minuteRaw === undefined ? 0 : Number(minuteRaw);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  return `${yearRaw}-${monthRaw}-${dayRaw}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 1 タスクを判断し、 タスク本体へ反映してから記録する。 */
export function decideTask(
  db: Db,
  sessionId: number,
  taskId: number,
  decision: TaskTriageDecisionKind,
  dueAtRaw: unknown,
  batchSize = DEFAULT_BATCH_SIZE,
  now: Date = new Date(),
): DecideResult {
  const session = getTriageSession(db, sessionId);
  if (!session) return { ok: false, code: 'not_found', error: 'session not found' };
  if (session.status !== 'active') return { ok: false, code: 'not_active', error: 'session is finished' };
  if (!session.task_ids.includes(taskId)) return { ok: false, code: 'not_in_session', error: 'task not in session' };
  const task = getTask(db, taskId);
  if (!task) return { ok: false, code: 'invalid', error: 'task no longer exists' };
  if (task.status === 'done' || task.due_at) {
    return { ok: false, code: 'conflict', error: 'task changed since this triage session was displayed' };
  }

  let dueAt: string | null = null;
  if (decision === 'due') {
    dueAt = normalizeDueAt(dueAtRaw);
    if (!dueAt) return { ok: false, code: 'invalid', error: 'due_at is required (YYYY-MM-DD or YYYY-MM-DDTHH:MM)' };
  }
  db.transaction(() => {
    if (decision === 'due') updateTaskWithJournal(db, taskId, { due_at: dueAt }, now);
    else if (decision === 'done') updateTaskWithJournal(db, taskId, { status: 'done' }, now);
    upsertTriageDecision(db, sessionId, taskId, decision, dueAt);
  })();
  return { ok: true, state: buildState(db, session, batchSize) };
}

export function finishSession(db: Db, sessionId: number): TaskTriageState | null {
  const session = getTriageSession(db, sessionId);
  if (!session) return null;
  if (session.status === 'active') setTriageSessionStatus(db, sessionId, 'finished', new Date().toISOString());
  const after = getTriageSession(db, sessionId) ?? session;
  return buildState(db, after);
}
