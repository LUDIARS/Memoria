import assert from 'node:assert/strict';
import { test } from 'node:test';
import type BetterSqlite3 from 'better-sqlite3';
import type { Hono } from 'hono';
import { makeShoppingRouter } from '../routes/shopping.js';
import { ShoppingCrawlCoordinator } from './crawl-coordinator.js';
import { requestScheduledShoppingRefresh } from './scheduler.js';
import type { ShoppingDigest, ShoppingSearchResult } from './types.js';

type Db = BetterSqlite3.Database;

function requestFrom(
  app: Hono,
  address: string,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(app.request(url, init, {
    incoming: {
      socket: {
        remoteAddress: address,
        remotePort: 12345,
        remoteFamily: address.includes(':') ? 'IPv6' : 'IPv4',
      },
    },
  }));
}

function searchResult(query: string): ShoppingSearchResult {
  return {
    query,
    searchedAt: '2026-08-19T00:00:00.000Z',
    winner: null,
    offers: [],
    failures: [],
  };
}

function digest(): ShoppingDigest {
  return {
    date: '2026-08-19',
    generatedAt: '2026-08-19T00:00:00.000Z',
    items: [],
    failures: [],
  };
}

function searchRequest(app: Hono, query: string, origin = 'http://localhost'): Promise<Response> {
  return requestFrom(app, '127.0.0.1', 'http://localhost/api/shopping/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ query }),
  });
}

test('shopping APIは同一端末・同一オリジンのリクエストだけを許可する', async () => {
  const app = makeShoppingRouter({
    db: {} as Db,
    coordinator: new ShoppingCrawlCoordinator(),
    search: async (_db, query) => searchResult(query),
  });
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
    body: JSON.stringify({ query: '牛乳' }),
  };

  const remote = await requestFrom(app, '192.168.1.25', 'http://localhost/api/shopping/search', init);
  assert.equal(remote.status, 403);
  const crossSite = await searchRequest(app, '牛乳', 'https://attacker.example');
  assert.equal(crossSite.status, 403);
  const local = await searchRequest(app, '牛乳');
  assert.equal(local.status, 200);
});

test('同じ検索を共有し、異なる並行クロールを429で制限する', async () => {
  let callCount = 0;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let finish: ((result: ShoppingSearchResult) => void) | undefined;
  const pending = new Promise<ShoppingSearchResult>((resolve) => { finish = resolve; });
  const app = makeShoppingRouter({
    db: {} as Db,
    coordinator: new ShoppingCrawlCoordinator(),
    search: async () => {
      callCount += 1;
      markStarted?.();
      return pending;
    },
  });

  const first = searchRequest(app, '牛乳');
  await started;
  const duplicate = searchRequest(app, '牛乳');
  const competing = await searchRequest(app, '食パン');
  assert.equal(competing.status, 429);
  assert.equal(competing.headers.get('Retry-After'), '5');
  assert.equal(callCount, 1);

  finish?.(searchResult('牛乳'));
  assert.equal((await first).status, 200);
  assert.equal((await duplicate).status, 200);
  assert.equal(callCount, 1);
});

test('日次巡回中は手動更新と検索を同じ共有ロックで制限する', async () => {
  const coordinator = new ShoppingCrawlCoordinator();
  let finishScheduled: ((value: ShoppingDigest) => void) | undefined;
  const scheduled = requestScheduledShoppingRefresh({} as Db, new Date('2026-08-19T00:00:00.000Z'), {
    coordinator,
    refreshDigest: async () => new Promise<ShoppingDigest>((resolve) => {
      finishScheduled = resolve;
    }),
  });
  assert.equal(scheduled.status, 'started');
  await Promise.resolve();

  let routeCallCount = 0;
  const app = makeShoppingRouter({
    db: {} as Db,
    coordinator,
    refreshDigest: async () => {
      routeCallCount += 1;
      return digest();
    },
    search: async (_db, query) => {
      routeCallCount += 1;
      return searchResult(query);
    },
  });

  const refresh = await requestFrom(app, '127.0.0.1', 'http://localhost/api/shopping/deals/refresh', {
    method: 'POST',
    headers: { Origin: 'http://localhost' },
  });
  assert.equal(refresh.status, 409);
  assert.equal((await searchRequest(app, '牛乳')).status, 429);
  assert.equal(routeCallCount, 0);

  finishScheduled?.(digest());
  await scheduled.promise;
});
