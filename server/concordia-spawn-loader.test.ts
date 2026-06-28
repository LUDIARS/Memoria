// loadConcordiaSpawn のユニットテスト。 importImpl seam で動的 import を差し替え、
// 契約検証 (factory 必須 / 返り値の形 / 未設定・import 失敗) を確認する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConcordiaSpawn } from './concordia-spawn-loader.js';

const goodApi = {
  spawn: async () => ({ ok: true as const, id: 's1', pid: 1, command: [] }),
  waitForSession: async () => 's1',
  inject: async () => { /* noop */ },
};

test('未設定パスは明示 Error', async () => {
  await assert.rejects(() => loadConcordiaSpawn('', { importImpl: async () => ({}) }), /not configured/);
});

test('createConcordiaSpawn を export していれば api を返す', async () => {
  const api = await loadConcordiaSpawn('mod', {
    importImpl: async () => ({ createConcordiaSpawn: () => goodApi }),
  });
  assert.equal(typeof api.spawn, 'function');
  assert.equal(typeof api.waitForSession, 'function');
  assert.equal(typeof api.inject, 'function');
});

test('default export の factory も許容', async () => {
  const api = await loadConcordiaSpawn('mod', {
    importImpl: async () => ({ default: () => goodApi }),
  });
  assert.equal(typeof api.inject, 'function');
});

test('factory が無いモジュールは Error', async () => {
  await assert.rejects(
    () => loadConcordiaSpawn('mod', { importImpl: async () => ({ somethingElse: 1 }) }),
    /must export createConcordiaSpawn/,
  );
});

test('factory の返り値が契約を満たさないと Error', async () => {
  await assert.rejects(
    () => loadConcordiaSpawn('mod', { importImpl: async () => ({ createConcordiaSpawn: () => ({ spawn: () => {} }) }) }),
    /must return \{ spawn, waitForSession, inject \}/,
  );
});

test('import 失敗は wrap した Error', async () => {
  await assert.rejects(
    () => loadConcordiaSpawn('mod', { importImpl: async () => { throw new Error('boom'); } }),
    /failed to import Concordia spawn module .*boom/,
  );
});

test('factory に factoryOptions を渡す', async () => {
  let received: unknown = undefined;
  await loadConcordiaSpawn('mod', {
    factoryOptions: { timeoutMs: 1234 },
    importImpl: async () => ({ createConcordiaSpawn: (o: unknown) => { received = o; return goodApi; } }),
  });
  assert.deepEqual(received, { timeoutMs: 1234 });
});
