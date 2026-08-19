import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowsSpendingAdviceRelay,
  DIARY_ONLY_SCOPE,
  resolveEffectiveRelayScope,
  SPENDING_ADVICE_SCOPE,
} from './relay-policy.js';

test('同意が無ければ scope は diary_only のまま', () => {
  assert.equal(resolveEffectiveRelayScope(false), DIARY_ONLY_SCOPE);
});

test('同意があれば助言 scope へ昇格する', () => {
  assert.equal(resolveEffectiveRelayScope(true), SPENDING_ADVICE_SCOPE);
});

test('diary_only は助言リレーを許可しない', () => {
  assert.equal(allowsSpendingAdviceRelay(DIARY_ONLY_SCOPE), false);
  assert.equal(allowsSpendingAdviceRelay(SPENDING_ADVICE_SCOPE), true);
});

