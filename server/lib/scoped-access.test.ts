import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { requireScope } from './scoped-access.js';

test('管理 token と取込 token を分離し、Host/Origin 偽装と不透明 origin を拒否する', async () => {
  const previous = { admin: process.env.MEMORIA_ADMIN_TOKEN, bookmark: process.env.MEMORIA_BOOKMARK_TOKEN };
  process.env.MEMORIA_ADMIN_TOKEN = 'fake-admin';
  process.env.MEMORIA_BOOKMARK_TOKEN = 'fake-bookmark';
  const app = new Hono();
  app.use('/config', requireScope('admin'));
  app.use('/bookmark', requireScope('bookmark'));
  app.all('*', (c) => c.json({ ok: true }));
  const send = (path: string, headers: Record<string, string> = {}, address = '192.168.1.5', host = 'localhost') =>
    app.request(`http://${host}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' },
      { incoming: { socket: { remoteAddress: address } } });
  try {
    assert.equal((await send('/config')).status, 403);
    assert.equal((await send('/config', { 'X-Memoria-Bookmark-Token': 'fake-bookmark' })).status, 403);
    assert.equal((await send('/bookmark', { 'X-Memoria-Admin-Token': 'fake-admin' })).status, 403);
    assert.equal((await send('/config', { 'X-Memoria-Admin-Token': 'fake-admin' })).status, 200);
    assert.equal((await send('/bookmark', { 'X-Memoria-Bookmark-Token': 'fake-bookmark', Origin: 'chrome-extension://example' })).status, 200);
    assert.equal((await send('/config', {}, '127.0.0.1')).status, 200);
    assert.equal((await send('/config', {}, '127.0.0.1', 'attacker.example')).status, 403);
    assert.equal((await send('/config', { Origin: 'null' }, '127.0.0.1')).status, 403);
    assert.equal((await send('/config', { Origin: 'https://attacker.example' }, '127.0.0.1')).status, 403);
    assert.equal((await send('/config', { 'Content-Type': 'text/plain' }, '127.0.0.1')).status, 415);
    delete process.env.MEMORIA_BOOKMARK_TOKEN;
    assert.equal((await send('/bookmark', { 'X-Memoria-Bookmark-Token': 'fake-bookmark' })).status, 403);
  } finally {
    for (const [key, value] of [['MEMORIA_ADMIN_TOKEN', previous.admin], ['MEMORIA_BOOKMARK_TOKEN', previous.bookmark]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});
