// runtime-paths のユニットテスト。dist/server.js (bundle) とソース直読みの両方で
// server/ 基準のパスが同じになることを確認する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IS_COMPILED, REPO_ROOT, SERVER_DIR, isCompiledModule, sourceDirOf } from './runtime-paths.js';

const here = dirname(fileURLToPath(import.meta.url));

test('dist/server.js から読まれたら server/ に戻す', () => {
  const url = pathToFileURL(join(here, 'dist', 'server.js')).href;
  assert.equal(isCompiledModule(url), true);
  assert.equal(sourceDirOf(url), here);
});

test('ソースの .ts はその場所のまま', () => {
  const url = pathToFileURL(join(here, 'plugins', 'host.ts')).href;
  assert.equal(isCompiledModule(url), false);
  assert.equal(sourceDirOf(url), join(here, 'plugins'));
});

test('dist 以外のフォルダの .js はコンパイル版とみなさない', () => {
  const url = pathToFileURL(join(here, 'public', 'app.js')).href;
  assert.equal(isCompiledModule(url), false);
  assert.equal(sourceDirOf(url), join(here, 'public'));
});

test('ソース実行では SERVER_DIR = server/、REPO_ROOT = その親', () => {
  assert.equal(IS_COMPILED, false);
  assert.equal(SERVER_DIR, here);
  assert.equal(basename(SERVER_DIR), 'server');
  assert.equal(REPO_ROOT, dirname(here));
});
