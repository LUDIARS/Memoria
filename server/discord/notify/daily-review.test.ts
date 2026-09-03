// selectOverdueReviewItems のユニットテスト。
// Discord の朝の棚卸しが「期限超過だけ」を対象にし、 期限未設定を拾わないことを保証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectOverdueReviewItems } from './daily-review.js';
import type { TaskRow } from '../../db/types/task.js';
import type { NotifyFilter } from './types.js';

function task(over: Partial<TaskRow> & { id: number }): TaskRow {
  return {
    title: `t${over.id}`, details: null, status: 'todo', kind: 'task', creator_type: 'human',
    due_at: null, share_actio: 0, shared_at: null, shared_origin: null, category: null,
    created_at: '', updated_at: '',
    ...over,
  };
}

const allCategories: NotifyFilter = { categories: ['all'], deadline: 'due_today_or_overdue' };
// Production defines "today" in the host's local timezone, so keep the fixture local too.
const now = new Date(2026, 8, 4, 8);

test('期限未設定は棚卸し対象に入らない', () => {
  const items = selectOverdueReviewItems([task({ id: 1, due_at: null })], allCategories, now);
  assert.deepEqual(items, []);
});

test('昨日以前が期限のタスクだけを拾う (local 形式 / ISO 形式)', () => {
  const tasks = [
    task({ id: 1, due_at: null }),
    task({ id: 2, due_at: '2026-09-03T23:59' }),
    task({ id: 3, due_at: '2026-08-30T00:00:00.000Z' }),
  ];
  assert.deepEqual(selectOverdueReviewItems(tasks, allCategories, now), [
    { taskId: 2, bucket: 'overdue' },
    { taskId: 3, bucket: 'overdue' },
  ]);
});

test('今日締切と未来の期限は対象外 (超過してから拾う)', () => {
  const tasks = [
    task({ id: 1, due_at: '2026-09-04T00:00' }),
    task({ id: 2, due_at: '2026-09-04T23:59' }),
    task({ id: 3, due_at: '2026-09-10T10:00' }),
  ];
  assert.deepEqual(selectOverdueReviewItems(tasks, allCategories, now), []);
});

test('不正な due_at は対象外', () => {
  const items = selectOverdueReviewItems([task({ id: 1, due_at: 'not-a-date' })], allCategories, now);
  assert.deepEqual(items, []);
});

test('カテゴリ指定は合致するタスクだけを残す', () => {
  const tasks = [
    task({ id: 1, due_at: '2026-09-01T10:00', category: '開発, 学習' }),
    task({ id: 2, due_at: '2026-09-01T10:00', category: '買い物' }),
    task({ id: 3, due_at: '2026-09-01T10:00', category: null }),
  ];
  const filter: NotifyFilter = { categories: ['開発'], deadline: 'due_today_or_overdue' };
  assert.deepEqual(selectOverdueReviewItems(tasks, filter, now), [{ taskId: 1, bucket: 'overdue' }]);
});
