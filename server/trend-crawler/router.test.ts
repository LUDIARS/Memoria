import assert from 'node:assert/strict';
import { test } from 'node:test';
import type BetterSqlite3 from 'better-sqlite3';
import type { Hono } from 'hono';
import { TrendCrawlCoordinator } from './coordinator.js';
import { makeTrendCrawlerRouter } from './router.js';
import type { TrendCrawlResult, TrendOverview } from './types.js';

type Db = BetterSqlite3.Database;

function requestFrom(app: Hono, address: string, url: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(app.request(url, init, {
    incoming: { socket: { remoteAddress: address, remotePort: 12345, remoteFamily: address.includes(':') ? 'IPv6' : 'IPv4' } },
  }));
}

const result: TrendCrawlResult = { crawledAt: '2026-10-14T00:00:00.000Z', ok: 1, failed: [], summaryError: null };
const overview: TrendOverview = { lastCrawledAt: null, summary: null, crossHits: [], genres: [] };
const postInit = { method: 'POST', headers: { Origin: 'http://localhost' } };

test('trend-crawler API は同一端末のリクエストだけ通す', async () => {
  const app = makeTrendCrawlerRouter({ db: {} as Db, coordinator: new TrendCrawlCoordinator(), crawl: async () => result, overview: () => overview });
  assert.equal((await requestFrom(app, '192.168.1.25', 'http://localhost/api/trend-crawler/overview')).status, 403);
  const response = await requestFrom(app, '127.0.0.1', 'http://localhost/api/trend-crawler/overview');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { overview, busy: false });
});

test('巡回中の手動更新は 409 にする', async () => {
  let finish: ((r: TrendCrawlResult) => void) | undefined;
  let calls = 0;
  const app = makeTrendCrawlerRouter({
    db: {} as Db,
    coordinator: new TrendCrawlCoordinator(),
    overview: () => overview,
    crawl: () => { calls += 1; return new Promise<TrendCrawlResult>((resolve) => { finish = resolve; }); },
  });
  const first = requestFrom(app, '127.0.0.1', 'http://localhost/api/trend-crawler/refresh', postInit);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await requestFrom(app, '127.0.0.1', 'http://localhost/api/trend-crawler/refresh', postInit);
  assert.equal(second.status, 409);
  finish?.(result);
  const done = await first;
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { result, overview });
  assert.equal(calls, 1);
});
