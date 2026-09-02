// /api/task-triage — 期限未設定タスクの棚卸しセッション API。
// Spec: spec/feature/task-triage.md §API

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import type { TaskRow } from '../db/types/task.js';
import { isSameMachineRequest } from '../lib/local-request.js';
import {
  clampBatchSize, countUndatedTasks, decideTask, finishSession, getCurrentState, startSession, buildState,
} from './session.js';
import { getTriageSession, listTriageSessions } from './store.js';
import { suggestForBatch } from './suggest.js';
import { TRIAGE_DECISION_KINDS, type TaskTriageDecisionKind, type TaskTriageSuggestion } from './types.js';

type Db = BetterSqlite3.Database;

export interface TaskTriageRouterDeps {
  db: Db;
  /** テストで LLM を差し替える。 */
  suggest?: (tasks: TaskRow[]) => Promise<TaskTriageSuggestion[]>;
}

function parseId(c: Context): number | null {
  const raw = c.req.param('id');
  if (raw == null || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

export function makeTaskTriageRouter(deps: TaskTriageRouterDeps): Hono {
  const { db } = deps;
  const suggest = deps.suggest ?? ((tasks: TaskRow[]) => suggestForBatch(tasks));
  const r = new Hono();

  const requireSameMachine: MiddlewareHandler = async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!isSameMachineRequest(c)) return c.json({ error: 'same-machine access required' }, 403);
    await next();
  };
  r.use('/api/task-triage', requireSameMachine);
  r.use('/api/task-triage/*', requireSameMachine);

  // 現在の active セッション (無ければ null) + 期限未設定の総数。
  r.get('/api/task-triage/session', (c: Context) => {
    const batchSize = clampBatchSize(c.req.query('batch'));
    return c.json({ state: getCurrentState(db, batchSize), undated_total: countUndatedTasks(db) });
  });

  // 開始 (active があれば再開)。 { restart: true } で集め直す。
  r.post('/api/task-triage/session', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { restart?: unknown; batch?: unknown };
    const state = startSession(db, { restart: body.restart === true, batchSize: clampBatchSize(body.batch) });
    return c.json({ state });
  });

  r.get('/api/task-triage/sessions', (c: Context) => c.json({ items: listTriageSessions(db) }));

  r.get('/api/task-triage/session/:id', (c: Context) => {
    const id = parseId(c);
    if (id == null) return c.json({ error: 'invalid id' }, 400);
    const session = getTriageSession(db, id);
    if (!session) return c.json({ error: 'not found' }, 404);
    return c.json({ state: buildState(db, session, clampBatchSize(c.req.query('batch'))) });
  });

  // 1 タスクの判断。 { task_id, decision: 'due'|'done'|'keep'|'later', due_at? }
  r.post('/api/task-triage/session/:id/decide', async (c: Context) => {
    const id = parseId(c);
    if (id == null) return c.json({ error: 'invalid id' }, 400);
    const body = await c.req.json().catch(() => ({})) as { task_id?: unknown; decision?: unknown; due_at?: unknown; batch?: unknown };
    const taskId = typeof body.task_id === 'number' ? body.task_id : Number(body.task_id);
    if (!Number.isSafeInteger(taskId) || taskId <= 0) return c.json({ error: 'task_id is required' }, 400);
    if (!TRIAGE_DECISION_KINDS.includes(body.decision as TaskTriageDecisionKind)) {
      return c.json({ error: `decision must be one of ${TRIAGE_DECISION_KINDS.join('/')}` }, 400);
    }
    const result = decideTask(db, id, taskId, body.decision as TaskTriageDecisionKind, body.due_at, clampBatchSize(body.batch));
    if (result.ok) return c.json({ ok: true, state: result.state });
    if (result.code === 'not_found') return c.json({ error: result.error }, 404);
    if (result.code === 'not_active' || result.code === 'conflict') return c.json({ error: result.error }, 409);
    return c.json({ error: result.error }, 400);
  });

  // 提示中バッチへの AI 提案 (適用はしない)。
  r.post('/api/task-triage/session/:id/suggest', async (c: Context) => {
    const id = parseId(c);
    if (id == null) return c.json({ error: 'invalid id' }, 400);
    const session = getTriageSession(db, id);
    if (!session) return c.json({ error: 'not found' }, 404);
    if (session.status !== 'active') return c.json({ error: 'session is finished' }, 409);
    const body = await c.req.json().catch(() => ({})) as { batch?: unknown };
    const state = buildState(db, session, clampBatchSize(body.batch));
    try {
      const suggestions = await suggest(state.batch);
      return c.json({ suggestions });
    } catch {
      // Provider/CLI errors may contain local paths or endpoint response bodies.
      return c.json({ error: 'failed to generate task triage suggestions' }, 500);
    }
  });

  r.post('/api/task-triage/session/:id/finish', (c: Context) => {
    const id = parseId(c);
    if (id == null) return c.json({ error: 'invalid id' }, 400);
    const state = finishSession(db, id);
    if (!state) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true, state });
  });

  return r;
}
