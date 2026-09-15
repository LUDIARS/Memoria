import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { openDb } from '../db.js';
import type { PushPayload } from '../push.js';
import { makeNotificationsRouter, parseInboundNotification } from './notifications.js';

function appWith(sent: PushPayload[]) {
  const db = openDb(':memory:');
  const app = new Hono();
  app.route('/', makeNotificationsRouter({
    db,
    send: async (_db, payload) => {
      sent.push(payload);
      return { push: { sent: 1, revoked: 0, errors: [] }, alexa: { status: 'skipped', pending: 0 } } as never;
    },
  }));
  return { app, db };
}

test('inbound notification is delivered with a tag derived from source, event and task', async () => {
  const sent: PushPayload[] = [];
  const { app, db } = appWith(sent);
  try {
    const res = await app.request('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'タスク完了', body: '見積もりを確定', url: '/tasks', source: 'actio', event: 'task.completed', task_id: 'task-1' }),
    });
    assert.equal(res.status, 202);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, 'タスク完了');
    assert.equal(sent[0].tag, 'actio:task.completed:task-1');
    assert.equal(sent[0].url, '/tasks');
  } finally {
    db.close();
  }
});

test('inbound notification rejects missing title and unsafe urls without delivering', async () => {
  const sent: PushPayload[] = [];
  const { app, db } = appWith(sent);
  try {
    const missing = await app.request('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'actio' }),
    });
    assert.equal(missing.status, 400);
    const unsafe = await app.request('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x', source: 'actio', url: 'javascript:alert(1)' }),
    });
    assert.equal(unsafe.status, 400);
    assert.equal(sent.length, 0);
  } finally {
    db.close();
  }
});

test('parseInboundNotification requires a label-safe source', () => {
  assert.equal(parseInboundNotification({ title: 'x' }).ok, false);
  assert.equal(parseInboundNotification({ title: 'x', source: 'has space' }).ok, false);
  const parsed = parseInboundNotification({ title: ' x ', source: 'actio', tag: 'custom' });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.title, 'x');
    assert.equal(parsed.value.tag, 'custom');
    assert.equal(parsed.value.url, '/');
  }
});
