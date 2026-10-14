import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import type { Hono } from 'hono';
import { TrendCrawlCoordinator } from './coordinator.js';
import { makeTrendCrawlerRouter } from './router.js';
import { clickStats, getInterestPrefs } from './interest-store.js';
import { ensureTrendCrawlerSchema } from './schema.js';
import type { TrendMap } from './map.js';
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

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method, headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

function memoryDb(): Db {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
  ensureTrendCrawlerSchema(db);
  return db;
}

test('マップ・興味・開いた記録の API', async () => {
  const db = memoryDb();
  const map: TrendMap = { lastCrawledAt: null, prefs: { genreWeights: {}, keywords: [] }, genres: [], tiles: [] };
  const app = makeTrendCrawlerRouter({ db, coordinator: new TrendCrawlCoordinator(), overview: () => overview, map: () => map });
  const got = await requestFrom(app, '127.0.0.1', 'http://localhost/api/trend-crawler/map');
  assert.deepEqual(await got.json(), { map, busy: false });

  const bad = await requestFrom(app, '127.0.0.1', 'http://localhost/api/trend-crawler/interest', jsonInit('PUT', { genreWeights: { tech: 9 }, keywords: [] }));
  assert.equal(bad.status, 400);
  const ok = await requestFrom(app, '127.0.0.1', 'http://localhost/api/trend-crawler/interest', jsonInit('PUT', { genreWeights: { tech: 2 }, keywords: ['AI'] }));
  assert.equal(ok.status, 200);
  assert.deepEqual(getInterestPrefs(db), { genreWeights: { tech: 2 }, keywords: ['AI'] });

  assert.equal((await requestFrom(app, '127.0.0.1', 'http://localhost/api/trend-crawler/click', jsonInit('POST', { key: 'a', genre: 'nope', sourceId: 's' }))).status, 400);
  assert.equal((await requestFrom(app, '127.0.0.1', 'http://localhost/api/trend-crawler/click', jsonInit('POST', { key: 'a', genre: 'tech', sourceId: 'hn' }))).status, 200);
  assert.equal(clickStats(db).byGenre.get('tech'), 1);
  assert.equal((await requestFrom(app, '192.168.1.25', 'http://localhost/api/trend-crawler/click', jsonInit('POST', { key: 'a', genre: 'tech', sourceId: 'hn' }))).status, 403);
});
