import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SHOPPING_CONFIG,
  shoppingConfigSchema,
  shoppingDigestSchema,
  upgradeShoppingConfigDefaults,
} from './config.js';

const NETWORK_SUPERMARKET_IDS = ['aeon-netsuper', 'maruetsu-online-delivery'];

test('旧設定へYahoo!ショッピングとネットスーパーを一度だけ追加する', () => {
  const oldConfig = shoppingConfigSchema.parse({
    enabled: true,
    refreshHour: 7,
    maxItemsPerSource: 6,
    sources: DEFAULT_SHOPPING_CONFIG.sources.filter((source) => (
      source.id !== 'yahoo-shopping' && !NETWORK_SUPERMARKET_IDS.includes(source.id)
    )),
  });
  const upgraded = upgradeShoppingConfigDefaults(oldConfig);
  assert.equal(upgraded.defaultsVersion, 2);
  assert.equal(upgraded.sources.filter((source) => source.id === 'yahoo-shopping').length, 1);
  for (const id of NETWORK_SUPERMARKET_IDS) {
    assert.equal(upgraded.sources.filter((source) => source.id === id).length, 1);
  }
  assert.equal(upgradeShoppingConfigDefaults(upgraded).sources.length, upgraded.sources.length);
});

test('version 1の設定へイオンとマルエツだけを追加する', () => {
  const versionOne = shoppingConfigSchema.parse({
    ...DEFAULT_SHOPPING_CONFIG,
    defaultsVersion: 1,
    sources: DEFAULT_SHOPPING_CONFIG.sources.filter((source) => !NETWORK_SUPERMARKET_IDS.includes(source.id)),
  });
  const upgraded = upgradeShoppingConfigDefaults(versionOne);
  assert.equal(upgraded.defaultsVersion, 2);
  assert.equal(upgraded.sources.filter((source) => source.id === 'yahoo-shopping').length, 1);
  for (const id of NETWORK_SUPERMARKET_IDS) {
    assert.equal(upgraded.sources.filter((source) => source.id === id).length, 1);
  }
});

test('移行後に既定ソースを削除した設定には再追加しない', () => {
  const removed = {
    ...DEFAULT_SHOPPING_CONFIG,
    sources: DEFAULT_SHOPPING_CONFIG.sources.filter((source) => (
      source.id !== 'yahoo-shopping' && !NETWORK_SUPERMARKET_IDS.includes(source.id)
    )),
  };
  const upgraded = upgradeShoppingConfigDefaults(removed);
  assert.equal(upgraded.sources.some((source) => source.id === 'yahoo-shopping'), false);
  for (const id of NETWORK_SUPERMARKET_IDS) {
    assert.equal(upgraded.sources.some((source) => source.id === id), false);
  }
});

test('上限まで登録済みの旧設定は利用者の巡回先を落とさず移行する', () => {
  const template = DEFAULT_SHOPPING_CONFIG.sources[0];
  const full = shoppingConfigSchema.parse({
    defaultsVersion: 0,
    enabled: true,
    refreshHour: 7,
    maxItemsPerSource: 6,
    sources: Array.from({ length: 30 }, (_, index) => ({
      ...template,
      id: `custom-${index}`,
      name: `利用者の店舗${index}`,
    })),
  });
  const upgraded = upgradeShoppingConfigDefaults(full);
  assert.equal(upgraded.defaultsVersion, DEFAULT_SHOPPING_CONFIG.defaultsVersion);
  assert.equal(upgraded.sources.length, 30);
  assert.deepEqual(upgraded.sources.map((source) => source.id), full.sources.map((source) => source.id));
  assert.equal(shoppingConfigSchema.safeParse(upgraded).success, true);
});

test('未対応の将来版設定を受け入れない', () => {
  const parsed = shoppingConfigSchema.safeParse({
    ...DEFAULT_SHOPPING_CONFIG,
    defaultsVersion: DEFAULT_SHOPPING_CONFIG.defaultsVersion + 1,
  });
  assert.equal(parsed.success, false);
});

test('保存済みダイジェストの外部リンクと型を検証する', () => {
  const base = {
    date: '2026-08-19',
    generatedAt: '2026-08-19T00:00:00.000Z',
    failures: [],
  };
  const invalid = shoppingDigestSchema.safeParse({
    ...base,
    items: [{
      sourceId: 'store', sourceName: '店', sourceKind: 'online', title: '商品',
      url: 'javascript:alert(1)', priceYen: 100, shippingYen: 0, totalYen: 100,
      shippingEvidence: 'page_free', saleLabel: null, observedAt: '2026-08-19T00:00:00.000Z',
    }],
  });
  assert.equal(invalid.success, false);
});
