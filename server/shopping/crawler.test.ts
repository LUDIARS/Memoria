import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readResponseBytes } from './crawler.js';

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
