// config / rule の正規化と文面の単体テスト。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, normalizeDestinations, normalizeRules } from './config.js';
import { composePresenceMessage, DEFAULT_MESSAGES, shouldSend } from './message.js';
import type { TaskRow } from '../db/types/task.js';
import type { PresenceRule } from './types.js';

test('config は既定値と範囲に矯正する', () => {
  assert.deepEqual(normalizeConfig(null), { enabled: false, nearRadiusM: 1000, hysteresisM: 50, staleMin: 15, cooldownMin: 10 });
  const c = normalizeConfig({ enabled: true, nearRadiusM: 10, hysteresisM: 9999, staleMin: '30', cooldownMin: -1 });
  assert.deepEqual(c, { enabled: true, nearRadiusM: 300, hysteresisM: 300, staleMin: 30, cooldownMin: 0 });
});

test('送り先は既知の種類だけ・重複なし・channel は既知のものだけ', () => {
  const d = normalizeDestinations([
    { kind: 'line' }, { kind: 'line' },
    { kind: 'discord', channel: 'task' }, { kind: 'discord', channel: 'unknown' },
    { kind: 'slack' }, null,
  ]);
  assert.deepEqual(d, [{ kind: 'line' }, { kind: 'discord', channel: 'task' }, { kind: 'discord', channel: 'announce' }]);
});

test('rule は欠けた項目を補い、 不明な event は depart にする', () => {
  const [r] = normalizeRules([{ event: 'teleport', filter: { categories: [' 買い物 ', ''] } }]);
  assert.equal(r.event, 'depart');
  assert.ok(r.id.length > 0);
  assert.equal(r.name, '帰宅・出発通知');
  assert.equal(r.includeTasks, true);
  assert.equal(r.sendWhenEmpty, false);
  assert.deepEqual(r.filter, { categories: ['買い物'], deadline: 'due_today_or_overdue' });
  assert.deepEqual(r.destinations, []);
});

function rule(over: Partial<PresenceRule> = {}): PresenceRule {
  return {
    id: 'r1', name: '買い物', enabled: true, event: 'depart', message: '', includeTasks: true,
    filter: { categories: ['買い物'], deadline: 'all' }, sendWhenEmpty: false, destinations: [{ kind: 'line' }],
    ...over,
  };
}

function task(id: number, title: string, category: string | null = '買い物'): TaskRow {
  return {
    id, title, details: null, status: 'todo', kind: 'task', creator_type: 'human', due_at: null,
    share_actio: 0, shared_at: null, shared_origin: null, category, created_at: '', updated_at: '',
  } as TaskRow;
}

test('文面は一言 + タスク一覧。 一言が空なら event の既定文', () => {
  const text = composePresenceMessage(rule(), 'depart', [task(1, '牛乳'), task(2, '卵', '買い物,memo')]);
  assert.equal(text, `${DEFAULT_MESSAGES.depart}\n買い物 (2 件)\n・[買い物] 牛乳\n・[買い物] 卵`);
  assert.equal(composePresenceMessage(rule({ message: 'いってらっしゃい', includeTasks: false }), 'depart', []), 'いってらっしゃい');
});

test('タスクを添える rule は 0 件なら送らない (sendWhenEmpty で送る)', () => {
  assert.equal(shouldSend(rule(), 0), false);
  assert.equal(shouldSend(rule(), 1), true);
  assert.equal(shouldSend(rule({ sendWhenEmpty: true }), 0), true);
  assert.equal(shouldSend(rule({ includeTasks: false }), 0), true);
});
