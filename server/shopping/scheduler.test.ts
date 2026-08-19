import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SHOPPING_CONFIG } from './config.js';
import { shouldRefreshShoppingDigest } from './scheduler.js';

const NOW = new Date(2026, 7, 19, 8, 0, 0);

test('日次巡回は有効・設定時刻後・当日未実行・再試行間隔経過時だけ開始する', () => {
  const config = structuredClone(DEFAULT_SHOPPING_CONFIG);
  assert.equal(shouldRefreshShoppingDigest(config, null, NOW, 0), true);
  assert.equal(shouldRefreshShoppingDigest({ ...config, enabled: false }, null, NOW, 0), false);
  assert.equal(shouldRefreshShoppingDigest({ ...config, refreshHour: 9 }, null, NOW, 0), false);
  assert.equal(shouldRefreshShoppingDigest(config, '2026-08-19', NOW, 0), false);
  assert.equal(shouldRefreshShoppingDigest(config, null, NOW, NOW.getTime() - 60_000), false);
});

test('有効な巡回先がない場合は開始しない', () => {
  const config = structuredClone(DEFAULT_SHOPPING_CONFIG);
  config.sources.forEach((source) => { source.enabled = false; });
  assert.equal(shouldRefreshShoppingDigest(config, null, NOW, 0), false);
});
