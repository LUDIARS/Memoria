import '../tasks/test-backend.js';
// task-triage セッションの進行テスト (in-memory SQLite)。
// 開始 → バッチ提示 → 判断反映 → later の再提示 → 外部解決の飛ばし → 終了 を保証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, insertTask, updateTask, getTask } from '../db.js';
import type { TaskRow } from '../db/types/task.js';
import {
  startSession, decideTask, finishSession, getCurrentState, countUndatedTasks, orderUndatedTasks, normalizeDueAt,
} from './session.js';

async function seed(db: ReturnType<typeof openDb>): Promise<number[]> {
  const ids = [
    (await insertTask(db, { title: 'B-1 undated', category: 'Bravo' })),
    (await insertTask(db, { title: 'A-1 undated', category: 'Alpha' })),
    (await insertTask(db, { title: 'A-2 dated', category: 'Alpha', due_at: '2026-09-10T18:00' })),
    (await insertTask(db, { title: 'A-3 undated doing', category: 'Alpha', status: 'doing' })),
    (await insertTask(db, { title: 'Z done', category: 'Zulu', status: 'done' })),
    (await insertTask(db, { title: 'goal', kind: 'goal' })),
  ];
  return ids;
}

test('期限未設定の未完タスクだけがカテゴリ順→作成順で並ぶ', async () => {
  const db = openDb(':memory:');
  const [b1, a1, , a3] = (await seed(db));
  assert.equal((await countUndatedTasks(db)), 3);
  const state = (await startSession(db));
  assert.deepEqual(state.session.task_ids, [a1, a3, b1]);
  assert.equal(state.progress.total, 3);
  assert.equal(state.progress.remaining, 3);
  assert.deepEqual(state.batch.map((t) => t.id), [a1, a3, b1]);
});

test('開始済みなら再開 (同じセッション)、 restart で作り直す', async () => {
  const db = openDb(':memory:');
  (await seed(db));
  const first = (await startSession(db));
  const again = (await startSession(db));
  assert.equal(again.session.id, first.session.id);
  const restarted = (await startSession(db, { restart: true }));
  assert.notEqual(restarted.session.id, first.session.id);
  assert.equal((await getCurrentState(db))?.session.id, restarted.session.id);
});

test('due 判断はタスクに期限を書き、 バッチから消える', async () => {
  const db = openDb(':memory:');
  const [, a1] = (await seed(db));
  const s = (await startSession(db));
  const r = (await decideTask(db, s.session.id, a1, 'due', '2026-09-20'));
  assert.ok(r.ok);
  assert.equal((await getTask(db, a1))?.due_at, '2026-09-20T18:00');
  assert.equal(r.ok && r.state.progress.decided, 1);
  assert.equal(r.ok && r.state.progress.counts.due, 1);
  assert.ok(r.ok && !r.state.batch.some((t) => t.id === a1));
});

test('due で日付が無ければ invalid、 タスクは変わらない', async () => {
  const db = openDb(':memory:');
  const [, a1] = (await seed(db));
  const s = (await startSession(db));
  const r = (await decideTask(db, s.session.id, a1, 'due', 'soon'));
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'invalid');
  assert.equal((await getTask(db, a1))?.due_at, null);
});

test('実在しない日付・時刻は拒否する', () => {
  assert.equal(normalizeDueAt('2026-02-29'), null);
  assert.equal(normalizeDueAt('2028-02-29'), '2028-02-29T18:00');
  assert.equal(normalizeDueAt('2026-13-01'), null);
  assert.equal(normalizeDueAt('2026-04-31'), null);
  assert.equal(normalizeDueAt('2026-09-03T24:00'), null);
  assert.equal(normalizeDueAt('2026-09-03T23:60'), null);
});

test('done 判断はタスクを閉じる、 keep は触らず棚卸し済みになる', async () => {
  const db = openDb(':memory:');
  const [b1, a1] = (await seed(db));
  const s = (await startSession(db));
  assert.ok((await decideTask(db, s.session.id, a1, 'done', undefined)).ok);
  assert.equal((await getTask(db, a1))?.status, 'done');
  const r = (await decideTask(db, s.session.id, b1, 'keep', undefined));
  assert.ok(r.ok);
  assert.equal((await getTask(db, b1))?.due_at, null);
  assert.equal((await getTask(db, b1))?.status, 'todo');
  assert.equal(r.ok && r.state.progress.decided, 2);
  assert.equal(r.ok && r.state.progress.remaining, 1);
});

test('later は後回しにし、 未判断が尽きたら末尾で再提示される', async () => {
  const db = openDb(':memory:');
  const [b1, a1, , a3] = (await seed(db));
  const s = (await startSession(db));
  const r1 = (await decideTask(db, s.session.id, a1, 'later', undefined));
  assert.ok(r1.ok);
  assert.deepEqual(r1.ok && r1.state.batch.map((t) => t.id), [a3, b1, a1]);
  assert.equal(r1.ok && r1.state.progress.remaining, 3);
  assert.equal(r1.ok && r1.state.progress.deferred, 1);
  // 再判断で上書きできる。
  const r2 = (await decideTask(db, s.session.id, a1, 'keep', undefined));
  assert.equal(r2.ok && r2.state.progress.deferred, 0);
  assert.equal(r2.ok && r2.state.progress.counts.later, 0);
});

test('セッション外で完了/期限付与されたタスクは解決済みとして飛ばす', async () => {
  const db = openDb(':memory:');
  const [b1, a1, , a3] = (await seed(db));
  (await startSession(db));
  (await updateTask(db, a1, { status: 'done' }));
  (await updateTask(db, a3, { due_at: '2026-10-01T09:00' }));
  const state = (await getCurrentState(db));
  assert.deepEqual(state?.batch.map((t) => t.id), [b1]);
  assert.equal(state?.progress.decided, 2);
  assert.equal(state?.progress.remaining, 1);
});

test('表示後に外部更新されたタスクは stale 判断で上書きしない', async () => {
  const db = openDb(':memory:');
  const [b1, a1] = (await seed(db));
  const s = (await startSession(db));
  (await updateTask(db, a1, { due_at: '2026-10-01T09:00' }));
  (await updateTask(db, b1, { status: 'done' }));

  const staleDone = (await decideTask(db, s.session.id, a1, 'done', undefined));
  assert.equal(staleDone.ok === false && staleDone.code, 'conflict');
  assert.equal((await getTask(db, a1))?.status, 'todo');
  assert.equal((await getTask(db, a1))?.due_at, '2026-10-01T09:00');

  const staleDue = (await decideTask(db, s.session.id, b1, 'due', '2026-11-01'));
  assert.equal(staleDue.ok === false && staleDue.code, 'conflict');
  assert.equal((await getTask(db, b1))?.status, 'done');
  assert.equal((await getTask(db, b1))?.due_at, null);
});

test('triage 更新は AI 所有者変更と日記・活動ログを適用する', async () => {
  const db = openDb(':memory:');
  const dueId = (await insertTask(db, { title: 'AI due', creator_type: 'ai' }));
  const doneId = (await insertTask(db, { title: 'human done' }));
  const s = (await startSession(db));
  const now = new Date('2026-09-03T10:15:00+09:00');

  assert.ok((await decideTask(db, s.session.id, dueId, 'due', '2026-09-20', 10, now)).ok);
  assert.equal((await getTask(db, dueId))?.creator_type, 'human');
  assert.ok((await decideTask(db, s.session.id, doneId, 'done', undefined, 10, now)).ok);

  const diary = db.prepare(`SELECT notes FROM diary_entries WHERE date = '2026-09-03'`).get() as { notes: string };
  assert.match(diary.notes, /タスク更新: AI due/);
  assert.match(diary.notes, /タスク完了: human done/);
  const events = db.prepare(`SELECT kind, content FROM activity_events ORDER BY id`).all() as { kind: string; content: string }[];
  assert.deepEqual(events, [
    { kind: 'task_updated', content: 'AI due' },
    { kind: 'task_done', content: 'human done' },
  ]);
});

test('finish 後は decide できず、 active が無くなる', async () => {
  const db = openDb(':memory:');
  const [, a1] = (await seed(db));
  const s = (await startSession(db));
  const fin = (await finishSession(db, s.session.id));
  assert.equal(fin?.session.status, 'finished');
  assert.deepEqual(fin?.batch, []);
  assert.equal((await getCurrentState(db)), null);
  const r = (await decideTask(db, s.session.id, a1, 'keep', undefined));
  assert.equal(r.ok === false && r.code, 'not_active');
});

test('セッション外のタスク id は弾く', async () => {
  const db = openDb(':memory:');
  const [, , a2] = (await seed(db));
  const s = (await startSession(db));
  const r = (await decideTask(db, s.session.id, a2, 'keep', undefined));
  assert.equal(r.ok === false && r.code, 'not_in_session');
});

test('orderUndatedTasks / normalizeDueAt は純関数として振る舞う', () => {
  const mk = (id: number, over: Partial<TaskRow>): TaskRow => ({
    id, title: `t${id}`, details: null, status: 'todo', kind: 'task', creator_type: 'human',
    due_at: null, share_actio: 0, shared_at: null, shared_origin: null, category: null,
    created_at: '2026-01-01', updated_at: '', ...over,
  });
  const ordered = orderUndatedTasks([
    mk(1, { category: 'b', created_at: '2026-02-01' }),
    mk(2, { category: 'a', created_at: '2026-03-01' }),
    mk(3, { category: 'a', created_at: '2026-01-01' }),
    mk(4, { due_at: '2026-09-01T10:00' }),
  ]);
  assert.deepEqual(ordered.map((t) => t.id), [3, 2, 1]);
  assert.equal(normalizeDueAt('2026-09-05'), '2026-09-05T18:00');
  assert.equal(normalizeDueAt('2026-09-05T09:30'), '2026-09-05T09:30');
  assert.equal(normalizeDueAt('2026/09/05'), null);
  assert.equal(normalizeDueAt(undefined), null);
});
