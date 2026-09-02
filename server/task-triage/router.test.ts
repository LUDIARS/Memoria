// /api/task-triage の結合テスト (in-memory SQLite + Hono app.request)。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { openDb, insertTask, getTask } from '../db.js';
import { makeTaskTriageRouter } from './router.js';
import type { TaskTriageState, TaskTriageSuggestion } from './types.js';

const json = { 'Content-Type': 'application/json' };

function requestFrom(
  app: Hono,
  address: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(app.request(`http://localhost${path}`, init, {
    incoming: {
      socket: {
        remoteAddress: address,
        remotePort: 12345,
        remoteFamily: address.includes(':') ? 'IPv6' : 'IPv4',
      },
    },
  }));
}

function localRequest(app: Hono, path: string, init?: RequestInit): Promise<Response> {
  return requestFrom(app, '127.0.0.1', path, init);
}

function build() {
  const db = openDb(':memory:');
  const ids = [
    insertTask(db, { title: 'one', category: 'A' }),
    insertTask(db, { title: 'two', category: 'A' }),
    insertTask(db, { title: 'dated', category: 'A', due_at: '2026-09-10T18:00' }),
  ];
  const app = new Hono();
  app.route('/', makeTaskTriageRouter({
    db,
    suggest: async (tasks) => tasks.map((t): TaskTriageSuggestion => ({ task_id: t.id, action: 'keep', reason: 'test' })),
  }));
  return { db, ids, app };
}

test('GET session は未開始で null + 期限未設定件数', async () => {
  const { app } = build();
  const res = await localRequest(app, '/api/task-triage/session');
  const body = await res.json() as { state: TaskTriageState | null; undated_total: number };
  assert.equal(body.state, null);
  assert.equal(body.undated_total, 2);
});

test('開始 → decide → suggest → finish の一連が通る', async () => {
  const { app, db, ids } = build();
  const started = await (await localRequest(app, '/api/task-triage/session', { method: 'POST', headers: json, body: '{}' })).json() as { state: TaskTriageState };
  const sid = started.state.session.id;
  assert.equal(started.state.batch.length, 2);

  const bad = await localRequest(app, `/api/task-triage/session/${sid}/decide`, {
    method: 'POST', headers: json, body: JSON.stringify({ task_id: ids[0], decision: 'drop' }),
  });
  assert.equal(bad.status, 400);

  const due = await localRequest(app, `/api/task-triage/session/${sid}/decide`, {
    method: 'POST', headers: json, body: JSON.stringify({ task_id: ids[0], decision: 'due', due_at: '2026-09-30' }),
  });
  assert.equal(due.status, 200);
  assert.equal(getTask(db, ids[0])?.due_at, '2026-09-30T18:00');

  const stale = await localRequest(app, `/api/task-triage/session/${sid}/decide`, {
    method: 'POST', headers: json, body: JSON.stringify({ task_id: ids[0], decision: 'keep' }),
  });
  assert.equal(stale.status, 409);

  const sug = await (await localRequest(app, `/api/task-triage/session/${sid}/suggest`, { method: 'POST', headers: json, body: '{}' })).json() as { suggestions: TaskTriageSuggestion[] };
  assert.deepEqual(sug.suggestions.map((s) => s.task_id), [ids[1]]);

  const fin = await (await localRequest(app, `/api/task-triage/session/${sid}/finish`, { method: 'POST' })).json() as { state: TaskTriageState };
  assert.equal(fin.state.session.status, 'finished');
  assert.equal(fin.state.progress.decided, 1);

  const afterFinish = await localRequest(app, `/api/task-triage/session/${sid}/decide`, {
    method: 'POST', headers: json, body: JSON.stringify({ task_id: ids[1], decision: 'keep' }),
  });
  assert.equal(afterFinish.status, 409);

  const list = await (await localRequest(app, '/api/task-triage/sessions')).json() as { items: unknown[] };
  assert.equal(list.items.length, 1);
});

test('存在しないセッションは 404', async () => {
  const { app } = build();
  assert.equal((await localRequest(app, '/api/task-triage/session/999')).status, 404);
  assert.equal((await localRequest(app, '/api/task-triage/session/999/finish', { method: 'POST' })).status, 404);
});

test('同一端末・同一 origin だけが個人タスク API にアクセスできる', async () => {
  const { app } = build();
  const local = await localRequest(app, '/api/task-triage/session', {
    headers: { Origin: 'http://localhost' },
  });
  assert.equal(local.status, 200);

  const remote = await requestFrom(app, '192.0.2.10', '/api/task-triage/session');
  assert.equal(remote.status, 403);

  const crossOrigin = await localRequest(app, '/api/task-triage/session', {
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(crossOrigin.status, 403);

  const crossOriginMutation = await localRequest(app, '/api/task-triage/session', {
    method: 'POST',
    headers: { ...json, Origin: 'https://attacker.example' },
    body: '{}',
  });
  assert.equal(crossOriginMutation.status, 403);
});
