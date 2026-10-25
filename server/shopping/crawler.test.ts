import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readResponseBytes, crawlShoppingSource } from './crawler.js';
import { shoppingPinnedEvidence } from '../../augur/probes/pinned-retrieval.js';
import { BlockedUrlError } from '../shared/public-url.js';
import type { ShoppingSource } from './types.js';

test('買い物取得は各 hop の検査済み IP に接続を固定し DNS を再解決しない', async () => {
  const evidence = await shoppingPinnedEvidence();
  assert.deepEqual(evidence.resolutions, ['first.test', 'second.test']);
  assert.deepEqual(evidence.connections.map((connection) => connection.address), ['8.8.8.8', '1.1.1.1']);
  assert.ok(evidence.connections.every((connection) => connection.identity));
  assert.equal(evidence.bodyMatches, true);
});

const source: ShoppingSource = {
  id: 'test', name: 'test', kind: 'online', pageUrl: 'https://missing.test',
  searchUrlTemplate: null, shippingMode: 'free', flatShippingYen: null, enabled: true,
};

test('買い物取得は不正 URL・内部アドレス・非 HTTP URL を BlockedUrlError で拒否する', async () => {
  for (const pageUrl of ['not a url', 'http://127.0.0.1/shop', 'file:///shop']) {
    await assert.rejects(crawlShoppingSource({ ...source, pageUrl }), BlockedUrlError);
  }
});

test('買い物取得は DNS 失敗を BlockedUrlError で返す', async () => {
  await assert.rejects(crawlShoppingSource(source, undefined, {
    resolve: async () => { throw Object.assign(new Error('not found'), { syscall: 'getaddrinfo' }); },
  }), BlockedUrlError);
});

test('Content-Lengthなしの応答も上限到達時に読み取りを中止する', async () => {
  let wasCancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(3));
    },
    cancel() {
      wasCancelled = true;
    },
  }));

  await assert.rejects(() => readResponseBytes(response, 4), /page too large/);
  assert.equal(wasCancelled, true);
});

test('上限以内のチャンクを順序どおり結合する', async () => {
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  }));

  assert.deepEqual(await readResponseBytes(response, 4), new Uint8Array([1, 2, 3, 4]));
});
