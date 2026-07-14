import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { openDb, setAppSettings } from '../db.js';
import { makeTaskRouter } from './task.js';

test('Actio sharing preserves task classification and creator metadata', async () => {
  const db = openDb(':memory:');
  const originalFetch = globalThis.fetch;
  try {
    setAppSettings(db, {
      'features.tasks.actio_share.enabled': true,
      'actio.share_url': 'http://actio.test/api/tasks',
    });

    let sharedBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      sharedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ task: { id: 'actio-1' } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const app = new Hono();
    app.route('/', makeTaskRouter({ db }));
    const created = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Ship Calliope',
        details: 'Preserve task metadata',
        status: 'doing',
        kind: 'goal',
        category: 'planning,pm',
        creator_type: 'ai',
        due_at: '2026-07-31T09:00:00+09:00',
        _skip_discord_notify: true,
      }),
    });
    assert.equal(created.status, 201);
    const { task } = await created.json() as { task: { id: number } };

    const shared = await app.request(`/api/tasks/${task.id}/share/actio`, { method: 'POST' });
    assert.equal(shared.status, 200);
    assert.deepEqual(sharedBody, {
      source: 'memoria',
      external_id: `memoria-task-${task.id}`,
      title: 'Ship Calliope',
      details: 'Preserve task metadata',
      status: 'doing',
      kind: 'goal',
      category: 'planning,pm',
      creator_type: 'ai',
      due_at: '2026-07-31T09:00:00+09:00',
    });
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});
