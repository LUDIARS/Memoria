// coerceSuggestions / extractJsonObject のユニットテスト (LLM 出力の検証)。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSuggestPrompt, coerceSuggestions, extractJsonObject } from './suggest.js';

const now = new Date(2026, 8, 3, 9, 0, 0); // 2026-09-03 local

test('フェンス付き出力から JSON を抜き出す', () => {
  const obj = extractJsonObject('前置き\n```json\n{ "suggestions": [] }\n```\n後置き');
  assert.deepEqual(obj, { suggestions: [] });
  assert.equal(extractJsonObject('not json'), null);
});

test('未知 id / 不正 action / reason 無しは捨て、 due は日付を起こす', () => {
  const out = coerceSuggestions({
    suggestions: [
      { task_id: 1, action: 'due', due_in_days: 7, reason: '来週' },
      { task_id: 2, action: 'keep', reason: 'メモ' },
      { task_id: 3, action: 'done', reason: '' },
      { task_id: 99, action: 'keep', reason: '存在しない' },
      { task_id: 4, action: 'drop', reason: '不正' },
      { task_id: 1, action: 'keep', reason: '重複' },
    ],
  }, new Set([1, 2, 3, 4]), now);
  assert.deepEqual(out, [
    { task_id: 1, action: 'due', due_in_days: 7, due_at: '2026-09-10T18:00', reason: '来週' },
    { task_id: 2, action: 'keep', reason: 'メモ' },
  ]);
});

test('due_in_days は 1〜90 に丸め、 無ければ 7', () => {
  const out = coerceSuggestions({
    suggestions: [
      { task_id: 1, action: 'due', due_in_days: 0, reason: 'a' },
      { task_id: 2, action: 'due', due_in_days: 500, reason: 'b' },
      { task_id: 3, action: 'due', reason: 'c' },
    ],
  }, new Set([1, 2, 3]), now);
  assert.deepEqual(out.map((s) => s.due_in_days), [1, 90, 7]);
  assert.equal(out[2].due_at, '2026-09-10T18:00');
});

test('prompt の今日も期限計算と同じ local 日付を使う', () => {
  const task = {
    id: 1, title: 'midnight', details: null, status: 'todo', kind: 'task', creator_type: 'human',
    due_at: null, share_actio: 0, shared_at: null, shared_origin: null, category: null,
    created_at: '2026-09-01', updated_at: '2026-09-01',
  } as const;
  const localMidnight = new Date(2026, 8, 3, 0, 30, 0);
  const prompt = buildSuggestPrompt([task], localMidnight);
  assert.match(prompt, /今日は 2026-09-03/);
});
