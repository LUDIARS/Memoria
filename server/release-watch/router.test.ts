import assert from 'node:assert/strict';
import { test } from 'node:test';
import type BetterSqlite3 from 'better-sqlite3';
import type { Hono } from 'hono';
import { ReleaseCrawlCoordinator } from './coordinator.js';
import { makeReleaseWatchRouter } from './router.js';
import type { ReleaseDigest } from './types.js';

type Db = BetterSqlite3.Database;

function requestFrom(app: Hono, address: string, url: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(app.request(url, init, {
    incoming: { socket: { remoteAddress: address, remotePort: 12345, remoteFamily: address.includes(':') ? 'IPv6' : 'IPv4' } },
  }));
}

const digest: ReleaseDigest = { date: '2026-08-22', generatedAt: '2026-08-22T00:00:00.000Z', sources: [] };
const postInit = { method: 'POST', headers: { Origin: 'http://localhost' } };

test('release-watch API は同一端末のリクエストだけ通す', async () => {
  const app = makeReleaseWatchRouter({ db: {} as Db, coordinator: new ReleaseCrawlCoordinator(), refresh: async () => digest });
  assert.equal((await requestFrom(app, '192.168.1.25', 'http://localhost/api/release-watch/refresh', postInit)).status, 403);
  assert.equal((await requestFrom(app, '127.0.0.1', 'http://localhost/api/release-watch/refresh', postInit)).status, 200);
});

test('巡回中の手動更新は 409 にする', async () => {
  let finish: ((d: ReleaseDigest) => void) | undefined;
  let calls = 0;
  const app = makeReleaseWatchRouter({
    db: {} as Db,
    coordinator: new ReleaseCrawlCoordinator(),
    refresh: () => { calls += 1; return new Promise<ReleaseDigest>((resolve) => { finish = resolve; }); },
  });
  const first = requestFrom(app, '127.0.0.1', 'http://localhost/api/release-watch/refresh', postInit);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await requestFrom(app, '127.0.0.1', 'http://localhost/api/release-watch/refresh', postInit);
  assert.equal(second.status, 409);
  finish?.(digest);
  assert.equal((await first).status, 200);
  assert.equal(calls, 1);
});
