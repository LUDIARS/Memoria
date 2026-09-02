// selectReviewTasks / isOverdueTask のユニットテスト。
// 朝の棚卸しが「期限超過だけ」を対象にし、 期限未設定を拾わないことを保証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOverdueTask, selectReviewTasks, parseTaskReviewScope } from './scope.js';
import type { TaskRow } from '../db/types/task.js';

function task(over: Partial<TaskRow> & { id: number }): TaskRow {
  return {
    title: `t${over.id}`, details: null, status: 'todo', kind: 'task', creator_type: 'human',
    due_at: null, share_actio: 0, shared_at: null, shared_origin: null, category: null,
    created_at: '', updated_at: '',
    ...over,
  };
}

const now = new Date('2026-09-03T09:00:00+09:00');

test('期限なしは超過にならない', () => {
  assert.equal(isOverdueTask(task({ id: 1, due_at: null }), now), false);
});

test('期限が過去 (local 形式 / ISO 形式) なら超過', () => {
  assert.equal(isOverdueTask(task({ id: 1, due_at: '2026-09-01T10:00' }), now), true);
  assert.equal(isOverdueTask(task({ id: 2, due_at: '2026-08-30T00:00:00.000Z' }), now), true);
});

test('期限が未来なら超過ではない', () => {
  assert.equal(isOverdueTask(task({ id: 1, due_at: '2026-09-10T10:00' }), now), false);
});

test('done は期限が過去でも対象外', () => {
  assert.equal(isOverdueTask(task({ id: 1, due_at: '2026-01-01T00:00', status: 'done' }), now), false);
});

test('不正な due_at は超過扱いしない', () => {
  assert.equal(isOverdueTask(task({ id: 1, due_at: 'not-a-date' }), now), false);
});

test('overdue scope は期限超過の未完だけを残す (順序維持)', () => {
  const tasks = [
    task({ id: 1, due_at: null }),
    task({ id: 2, due_at: '2026-09-01T10:00' }),
    task({ id: 3, due_at: '2026-09-02T10:00', status: 'doing' }),
    task({ id: 4, due_at: '2026-12-01T10:00' }),
    task({ id: 5, due_at: '2026-01-01T10:00', status: 'done' }),
  ];
  assert.deepEqual(selectReviewTasks(tasks, 'overdue', now).map((t) => t.id), [2, 3]);
});

test('all scope は未完すべて (期限なし含む)', () => {
  const tasks = [
    task({ id: 1, due_at: null }),
    task({ id: 2, due_at: '2026-09-01T10:00' }),
    task({ id: 3, status: 'done' }),
  ];
  assert.deepEqual(selectReviewTasks(tasks, 'all', now).map((t) => t.id), [1, 2]);
});

test('scope の既定は overdue', () => {
  assert.equal(parseTaskReviewScope(undefined), 'overdue');
  assert.equal(parseTaskReviewScope('anything'), 'overdue');
  assert.equal(parseTaskReviewScope('all'), 'all');
});
