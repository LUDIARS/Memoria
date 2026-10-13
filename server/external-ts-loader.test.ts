// external-ts-loader のユニットテスト。dist 起動のときだけ loader を 1 回登録する。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureExternalTsLoader, resetExternalTsLoaderForTest } from './external-ts-loader.js';

beforeEach(() => resetExternalTsLoaderForTest());

test('ソース実行 (tsx 経由) では登録しない', async () => {
  let calls = 0;
  await ensureExternalTsLoader({ compiled: false, register: async () => { calls += 1; } });
  assert.equal(calls, 0);
});

test('dist 起動では 1 回だけ登録する', async () => {
  let calls = 0;
  const register = async () => { calls += 1; };
  await Promise.all([
    ensureExternalTsLoader({ compiled: true, register }),
    ensureExternalTsLoader({ compiled: true, register }),
  ]);
  await ensureExternalTsLoader({ compiled: true, register });
  assert.equal(calls, 1);
});

test('既定の判定はソース実行なので何もしない', async () => {
  await ensureExternalTsLoader();
});
