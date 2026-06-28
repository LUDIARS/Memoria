// detectSnapshotConflicts のユニットテスト (圧縮前の存在/変更ガード)。
// 朝の解析後にタスクが消えた/変わった場合に conflict を返すことを保証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSnapshotConflicts } from './apply.js';
import type { TaskRow } from '../db/types/task.js';
import type { TaskSnapshotEntry } from './types.js';

function task(over: Partial<TaskRow> & { id: number; title: string; status: TaskRow['status'] }): TaskRow {
  return {
    details: null, kind: 'task', creator_type: 'human', due_at: null,
    share_actio: 0, shared_at: null, shared_origin: null, category: null,
    created_at: '', updated_at: '',
    ...over,
  };
}

const snap = (id: number, title: string, status: string): TaskSnapshotEntry => ({ id, title, status });

test('全一致なら conflict なし', () => {
  const snapshot = [snap(1, 'A', 'todo'), snap(2, 'B', 'doing')];
  const cur = new Map<number, TaskRow | undefined>([
    [1, task({ id: 1, title: 'A', status: 'todo' })],
    [2, task({ id: 2, title: 'B', status: 'doing' })],
  ]);
  assert.deepEqual(detectSnapshotConflicts(snapshot, cur), []);
});

test('対象が消えていれば missing', () => {
  const snapshot = [snap(1, 'A', 'todo')];
  const cur = new Map<number, TaskRow | undefined>([[1, undefined]]);
  assert.deepEqual(detectSnapshotConflicts(snapshot, cur), [{ id: 1, kind: 'missing' }]);
});

test('title が変わっていれば changed', () => {
  const snapshot = [snap(1, 'A', 'todo')];
  const cur = new Map<number, TaskRow | undefined>([[1, task({ id: 1, title: 'A2', status: 'todo' })]]);
  assert.deepEqual(detectSnapshotConflicts(snapshot, cur), [{ id: 1, kind: 'changed' }]);
});

test('status が変わっていれば changed (既に done 等)', () => {
  const snapshot = [snap(1, 'A', 'todo')];
  const cur = new Map<number, TaskRow | undefined>([[1, task({ id: 1, title: 'A', status: 'done' })]]);
  assert.deepEqual(detectSnapshotConflicts(snapshot, cur), [{ id: 1, kind: 'changed' }]);
});

test('複数の不一致をすべて返す', () => {
  const snapshot = [snap(1, 'A', 'todo'), snap(2, 'B', 'todo'), snap(3, 'C', 'todo')];
  const cur = new Map<number, TaskRow | undefined>([
    [1, task({ id: 1, title: 'A', status: 'todo' })],   // ok
    [2, undefined],                                       // missing
    [3, task({ id: 3, title: 'C', status: 'doing' })],   // changed
  ]);
  assert.deepEqual(detectSnapshotConflicts(snapshot, cur), [
    { id: 2, kind: 'missing' },
    { id: 3, kind: 'changed' },
  ]);
});
