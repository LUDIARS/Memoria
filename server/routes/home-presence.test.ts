// 帰宅・出発通知 / LINE 設定 API のテスト。 座標・トークンを返さないこと、 管理 scope で守ること。

import '../tasks/test-backend.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hono } from 'hono';
import { openDb } from '../db.js';
import { saveState, loadState } from '../home-presence/state.js';
import { makeHomePresenceRouter } from './home-presence.js';
import { makeLineRouter } from './line.js';
import type { FetchLike } from '../line/client.js';

const LOCAL = '127.0.0.1';
const TO = `U${'b'.repeat(32)}`;

function requestFrom(app: Hono, address: string, url: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(app.request(url, init, {
    incoming: { socket: { remoteAddress: address, remotePort: 12345, remoteFamily: 'IPv4' } },
  }));
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: JSON.stringify(body) };
}

test('設定 API は同一端末 (または管理 token) だけ通す', async () => {
  const db = openDb(':memory:');
  try {
    const app = makeHomePresenceRouter({ db });
    const line = makeLineRouter({ db });
    assert.equal((await requestFrom(app, '192.168.1.25', 'http://localhost/api/home-presence')).status, 403);
    assert.equal((await requestFrom(line, '192.168.1.25', 'http://localhost/api/line/settings')).status, 403);
    assert.equal((await requestFrom(app, LOCAL, 'http://localhost/api/home-presence')).status, 200);
  } finally {
    db.close();
  }
});

test('GET は自宅の座標を返さない', async () => {
  const db = openDb(':memory:');
  try {
    db.prepare(`INSERT INTO work_locations (name, latitude, longitude, is_home, radius_m) VALUES ('自宅', 35.123456, 139.654321, 1, 120)`).run();
    const app = makeHomePresenceRouter({ db });
    const res = await requestFrom(app, LOCAL, 'http://localhost/api/home-presence');
    const text = await res.text();
    assert.doesNotMatch(text, /35\.123456|139\.654321/);
    const body = JSON.parse(text) as { status: { home: { source: string; radiusM: number } } };
    assert.deepEqual(body.status.home, { source: 'work_location', name: '自宅', radiusM: 120 });
  } finally {
    db.close();
  }
});

test('判定を ON にした時点で古い状態を捨てる', async () => {
  const db = openDb(':memory:');
  try {
    const app = makeHomePresenceRouter({ db });
    saveState(db, { zone: 'home', lastEventAt: {} });
    const res = await requestFrom(app, LOCAL, 'http://localhost/api/home-presence', jsonInit('PUT', { config: { enabled: true } }));
    assert.equal(res.status, 200);
    assert.equal(loadState(db), null);
    // ON のまま保存し直しても状態は消さない
    saveState(db, { zone: 'near', lastEventAt: {} });
    await requestFrom(app, LOCAL, 'http://localhost/api/home-presence', jsonInit('PUT', { config: { enabled: true, nearRadiusM: 800 } }));
    assert.equal(loadState(db)?.zone, 'near');
  } finally {
    db.close();
  }
});

test('LINE 設定はトークンを返さず、 テスト送信は保存した値で送る', async () => {
  const db = openDb(':memory:');
  const sent: string[] = [];
  const fake: FetchLike = async (_url, init) => {
    sent.push(init.headers.authorization);
    return { ok: true, status: 200, text: async () => '{}' };
  };
  try {
    const app = makeLineRouter({ db, fetchImpl: fake });
    const put = await requestFrom(app, LOCAL, 'http://localhost/api/line/settings', jsonInit('PUT', { token: 'secret-token', to: TO }));
    const putText = await put.text();
    assert.equal(put.status, 200);
    assert.doesNotMatch(putText, /secret-token/);
    const get = await requestFrom(app, LOCAL, 'http://localhost/api/line/settings');
    assert.deepEqual(await get.json(), { token_set: true, to: TO });
    const bad = await requestFrom(app, LOCAL, 'http://localhost/api/line/settings', jsonInit('PUT', { to: 'x' }));
    assert.equal(bad.status, 400);
    const test1 = await requestFrom(app, LOCAL, 'http://localhost/api/line/test', jsonInit('POST', {}));
    assert.equal(test1.status, 200);
    assert.deepEqual(sent, ['Bearer secret-token']);
  } finally {
    db.close();
  }
});
