import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RailStatusCache } from './cache.js';
import { REFRESH_MS, type RailData } from './types.js';
const data: RailData = { sourceUpdatedAt: '9月24日 13時24分更新', lines: Array.from({ length: 100 }, (_, id) => ({
  id: '/diainfo/' + id + '/0', name: '路線' + id, company: '事業者', status: '平常運転', detail: '案内',
  url: 'https://transit.yahoo.co.jp/diainfo/' + id + '/0', disrupted: false })) };

test('retains last success on outage or partial refresh and marks aged data stale', async () => {
  let now = 0;
  let fail = false;
  let partial = false;
  const cache = new RailStatusCache(async () => { if (fail) throw new Error('private error');
    return partial ? { ...data, lines: data.lines.slice(0, 50) } : data; }, () => now);
  assert.equal(cache.state().status, 'pending');
  await cache.refresh();
  const first = cache.state();
  now += REFRESH_MS * 2;
  assert.equal(cache.state().stale, true);
  fail = true;
  await cache.refresh();
  assert.equal(cache.state().status, 'error');
  assert.equal(cache.state().fetchedAt, first.fetchedAt);
  assert.equal(cache.state().lines.length, 100);
  fail = false; partial = true;
  await cache.refresh();
  assert.equal(cache.state().lines.length, 100);
  partial = false;
  await cache.refresh();
  assert.equal(cache.state().status, 'ok');
  assert.equal(cache.state().stale, false);
});

test('coalesces refreshes and ignores a result returned after stop', async () => {
  let calls = 0;
  let finish!: (value: RailData) => void;
  const cache = new RailStatusCache(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const running = cache.refresh();
  await cache.refresh();
  assert.equal(calls, 1);
  cache.stop();
  finish(data);
  await running;
  assert.equal(cache.state().status, 'pending');
});
