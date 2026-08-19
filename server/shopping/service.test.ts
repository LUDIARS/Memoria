import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawlShoppingSources, findShippingInclusiveWinner } from './service.js';
import type { ShoppingOffer, ShoppingSource } from './types.js';

function offer(sourceName: string, priceYen: number, shippingYen: number | null): ShoppingOffer {
  return {
    sourceId: sourceName,
    sourceName,
    sourceKind: 'online',
    title: 'テスト商品',
    url: 'https://example.com/item',
    priceYen,
    shippingYen,
    totalYen: shippingYen === null ? null : priceYen + shippingYen,
    shippingEvidence: shippingYen === null ? 'unknown' : 'page_amount',
    saleLabel: null,
    observedAt: '2026-07-13T00:00:00.000Z',
  };
}

test('最安判定は商品価格ではなく送料込み総額を使う', () => {
  const winner = findShippingInclusiveWinner([
    offer('商品は安いが送料が高い店', 900, 800),
    offer('送料込みで安い店', 1_200, 100),
  ]);
  assert.equal(winner?.sourceName, '送料込みで安い店');
  assert.equal(winner?.totalYen, 1_300);
});

test('送料不明の候補は安価でも最安判定から除外する', () => {
  const winner = findShippingInclusiveWinner([
    offer('送料不明店', 100, null),
    offer('送料確認済店', 500, 0),
  ]);
  assert.equal(winner?.sourceName, '送料確認済店');
});

test('巡回先が多くても同時取得数を4件に制限する', async () => {
  const sources: ShoppingSource[] = Array.from({ length: 12 }, (_, index) => ({
    id: `source-${index}`,
    name: `店舗${index}`,
    kind: 'online',
    pageUrl: `https://example.com/${index}`,
    searchUrlTemplate: null,
    shippingMode: 'page',
    flatShippingYen: null,
    enabled: true,
  }));
  let active = 0;
  let maxActive = 0;
  let callCount = 0;

  await crawlShoppingSources(sources, 1, {
    query: '牛乳',
    crawlSource: async () => {
      callCount += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      active -= 1;
      return [];
    },
  });

  assert.equal(callCount, sources.length);
  assert.equal(maxActive, 4);
});
