import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchRemainingUsage } from './remaining.js';

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
  assert.deepEqual(result, { points: [point] });
});

test('unavailable upstream and malformed observations fail instead of inventing a remaining limit', async () => {
  for (const response of [new Response('', { status: 503 }), Response.json({ points: [{ ts: 1 }] })]) {
    await assert.rejects(fetchRemainingUsage({ baseUrl: 'http://localhost:1234', fetchImpl: async () => response }), /Concordia/);
  }
});

test('empty history stays empty and credential-bearing connection URLs are rejected before fetch', async () => {
  assert.deepEqual(await fetchRemainingUsage({ baseUrl: 'http://localhost:1234',
    fetchImpl: async () => Response.json({ points: [] }) }), { points: [] });
  let calls = 0;
  await assert.rejects(fetchRemainingUsage({ baseUrl: 'http://user:secret@localhost',
    fetchImpl: async () => { calls++; return Response.json({ points: [] }); } }), /設定が不正/);
  assert.equal(calls, 0);
});
