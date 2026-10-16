import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchRemainingUsage, parseRemainingRange, REMAINING_RANGE_SECONDS } from './remaining.js';

test('remaining usage reads a bounded Cc history and returns only the public chart contract', async () => {
  const point = { ts: 1700000000, provider: 'codex-cli', plan: 'pro', used5hPct: null,
    usedWeeklyPct: 7, reset5hAt: null, resetWeeklyAt: 1700600000 };
  const result = await fetchRemainingUsage({ baseUrl: 'http://localhost:1234', now: () => 1700000000000,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/v1/cost/limit-timeseries');
      assert.equal(url.searchParams.get('since'), String(1700000000 - 604800));
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal);
      return Response.json({ points: [{ ...point, privatePath: '/private' }], secret: 'omit' });
    } });
  assert.deepEqual(result, { points: [point], range: '1w', from: 1700000000 - 604800, to: 1700000000 });
});

test('unavailable upstream and malformed observations fail instead of inventing a remaining limit', async () => {
  for (const response of [new Response('', { status: 503 }), Response.json({ points: [{ ts: 1 }] })]) {
    await assert.rejects(fetchRemainingUsage({ baseUrl: 'http://localhost:1234', fetchImpl: async () => response }), /Concordia/);
  }
});

test('empty history stays empty and credential-bearing connection URLs are rejected before fetch', async () => {
  assert.deepEqual(await fetchRemainingUsage({ baseUrl: 'http://localhost:1234', now: () => 1700000000000,
    fetchImpl: async () => Response.json({ points: [] }) }),
  { points: [], range: '1w', from: 1700000000 - 604800, to: 1700000000 });
  let calls = 0;
  await assert.rejects(fetchRemainingUsage({ baseUrl: 'http://user:secret@localhost',
    fetchImpl: async () => { calls++; return Response.json({ points: [] }); } }), /設定が不正/);
  assert.equal(calls, 0);
});

test('all five ranges query the selected window and exclude outside observations', async () => {
  const now = 1700000000;
  const makePoint = (ts: number) => ({ ts, provider: 'claude-code', plan: null, used5hPct: null,
    usedWeeklyPct: 20, reset5hAt: null, resetWeeklyAt: null });
  for (const range of ['3m', '1m', '1w', '1d', '1h'] as const) {
    const from = now - REMAINING_RANGE_SECONDS[range];
    const result = await fetchRemainingUsage({ baseUrl: 'http://localhost:1234', range, now: () => now * 1000,
      fetchImpl: async (input) => {
        assert.equal(new URL(String(input)).searchParams.get('since'), String(from));
        return Response.json({ points: [makePoint(from - 1), makePoint(from), makePoint(now), makePoint(now + 1)] });
      } });
    assert.deepEqual(result, { range, from, to: now, points: [makePoint(from), makePoint(now)] });
  }
});

test('range selection defaults to one week and rejects unknown or inherited object keys', () => {
  assert.equal(parseRemainingRange(undefined), '1w');
  for (const value of ['', '1y', 'constructor', '__proto__', 'toString']) {
    assert.throws(() => parseRemainingRange(value), RangeError);
  }
});

test('three-month history accepts more than the previous one-week row limit', async () => {
  const point = { ts: 1700000000, provider: 'codex-cli', plan: null, used5hPct: null,
    usedWeeklyPct: 10, reset5hAt: null, resetWeeklyAt: null };
  const result = await fetchRemainingUsage({ baseUrl: 'http://localhost:1234', range: '3m', now: () => 1700000000000,
    fetchImpl: async () => Response.json({ points: Array.from({ length: 10001 }, () => point) }) });
  assert.equal(result.points.length, 10001);
});
