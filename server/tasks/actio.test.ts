import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { listTasks, getTask, insertTask, updateTask } from './actio.js';
import { remoteTaskId } from './identity.js';

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: 'Remote task', description: 'details', status: 'open', kind: 'task',
  creatorType: 'human', category: null, deadline: null,
  createdAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z',
  pluginId: null, pluginRef: null, ...extra,
});
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('Actio owns content; imported IDs survive and native tasks cannot collide', async () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE tasks(id INTEGER PRIMARY KEY, title TEXT); INSERT INTO tasks VALUES(42, 'stale local title')");
  const fetchBefore = globalThis.fetch;
  const urlBefore = process.env.ACTIO_URL;
  process.env.ACTIO_URL = 'http://actio.test';
  let remoteTitle = 'Current remote title';
  const requests: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push({ path: url.pathname, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (init?.method === 'PATCH') {
        remoteTitle = JSON.parse(String(init.body)).title;
        return json({ task: row('imported', { title: remoteTitle }) });
      }
      const imported = row('imported', { title: remoteTitle, pluginId: 'memoria', pluginRef: 'memoria:42', pluginPayload: { memoria: { created_at: '2020-01-01T00:00:00Z' } } });
      if (url.pathname === '/api/tasks/imported') return json({ task: imported });
      assert.equal(url.searchParams.get('scope'), 'owned');
      return json({ tasks: [row('native'), imported] });
    };
    const tasks = await listTasks(db, { kind: 'all', limit: 200 });
    assert.equal(tasks[1].id, 42);
    assert.ok(tasks[0].id > 42);
    assert.equal(tasks[1].created_at, '2020-01-01T00:00:00Z');
    assert.equal(tasks[1].title, remoteTitle);
    assert.equal(remoteTaskId(db, 42), 'imported');
    await updateTask(db, 42, { title: 'Updated in Actio' });
    assert.equal((await getTask(db, 42))?.title, 'Updated in Actio');
    assert.equal((db.prepare('SELECT title FROM tasks WHERE id=42').get() as { title: string }).title, 'stale local title');
    assert.equal(requests.filter(r => r.method === 'PATCH').length, 1);
    const page = await listTasks(db, { kind: 'all', limit: 1, offset: 1 });
    assert.deepEqual(page.map(t => t.id), [42]);
  } finally {
    globalThis.fetch = fetchBefore;
    if (urlBefore === undefined) delete process.env.ACTIO_URL; else process.env.ACTIO_URL = urlBefore;
    db.close();
  }
});

test('Actio failures are visible and never insert into the archive', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE tasks(id INTEGER PRIMARY KEY, title TEXT)');
  const fetchBefore = globalThis.fetch;
  const urlBefore = process.env.ACTIO_URL;
  process.env.ACTIO_URL = 'http://actio.test';
  try {
    globalThis.fetch = async () => new Response('{}', { status: 503 });
    await assert.rejects(() => listTasks(db), /503/);
    await assert.rejects(() => insertTask(db, { title: 'must not be local' }), /503/);
    assert.deepEqual(db.prepare('SELECT * FROM tasks').all(), []);
    delete process.env.ACTIO_URL;
    await assert.rejects(() => listTasks(db), /ACTIO_URL is required/);
  } finally {
    globalThis.fetch = fetchBefore;
    if (urlBefore === undefined) delete process.env.ACTIO_URL; else process.env.ACTIO_URL = urlBefore;
    db.close();
  }
});
