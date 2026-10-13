// build-server の設定テスト。常駐 entry は bootstrap.ts → dist/server.js の 1 ファイルで、
// node_modules は bundle しない (ネイティブ addon / CJS 依存を実行時に読む)。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ENTRY, OUTFILE, serverBuildOptions } from './build-server.mjs';

test('bootstrap.ts を dist/server.js 1 本へ bundle する', () => {
  const root = join('x', 'server');
  const options = serverBuildOptions(root);
  assert.equal(ENTRY, 'bootstrap.ts');
  assert.equal(OUTFILE, 'dist/server.js');
  assert.equal(options.bundle, true);
  assert.equal(options.splitting, false);
  assert.equal(options.format, 'esm');
  assert.equal(options.platform, 'node');
  assert.equal(options.packages, 'external');
  assert.match(options.entryPoints[0], /bootstrap\.ts$/);
  assert.match(options.outfile, /dist[\\/]server\.js$/);
});
