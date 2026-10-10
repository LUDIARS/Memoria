import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { makeDiarySectionsRouter } from './sections-router.js';
import { deleteDiarySections, listDiarySections } from './sections-store.js';

const local = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const remote = { incoming: { socket: { remoteAddress: '192.0.2.1' } } };
const url = (path: string) => `http://localhost${path}`;
const put = (body: unknown) => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function setup() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE diary_entries (date TEXT PRIMARY KEY, summary TEXT, work_content TEXT, highlights TEXT, notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending', updated_at TEXT)`);
  db.prepare(`INSERT INTO diary_entries (date, summary, work_content, highlights, notes, status, updated_at)
    VALUES ('2026-10-09', 's', 'w', 'h', 'user memo', 'done', 'fixed')`).run();
  return { db, app: makeDiarySectionsRouter(db) };
}

test('PUT upserts one section per (date, source) and leaves the diary row untouched', async () => {
  const { db, app } = setup();
  try {
    const before = db.prepare('SELECT * FROM diary_entries').all();
    const first = await app.request(url('/api/diary/2026-10-09/sections/concordia-daily-goal'), put({ title: 'まとめ', markdown: '- a' }), local);
    assert.equal(first.status, 200);
    const second = await app.request(url('/api/diary/2026-10-09/sections/concordia-daily-goal'), put({ title: 'まとめ 2', markdown: '- b' }), local);
    assert.equal(second.status, 200);
    assert.equal((await second.json() as { markdown: string }).markdown, '- b');
    assert.equal(listDiarySections(db, '2026-10-09').length, 1);
    assert.deepEqual(db.prepare('SELECT * FROM diary_entries').all(), before);

    // A day without a diary row still stores the section (no diary row is created).
    assert.equal((await app.request(url('/api/diary/2026-10-08/sections/other'), put({ title: 't', markdown: 'm' }), local)).status, 200);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM diary_entries WHERE date = '2026-10-08'`).get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test('GET returns one section, the list, and 404 for a missing source', async () => {
  const { db, app } = setup();
  try {
    await app.request(url('/api/diary/2026-10-09/sections/a'), put({ title: 'A', markdown: 'x' }), local);
    await app.request(url('/api/diary/2026-10-09/sections/b'), put({ title: 'B', markdown: 'y' }), local);
    const one = await app.request(url('/api/diary/2026-10-09/sections/a'), {}, local);
    assert.equal(one.status, 200);
    assert.equal((await one.json() as { title: string }).title, 'A');
    assert.equal((await app.request(url('/api/diary/2026-10-09/sections/missing'), {}, local)).status, 404);
    const list = await (await app.request(url('/api/diary/2026-10-09/sections'), {}, local)).json() as { items: { source: string }[] };
    assert.deepEqual(list.items.map((s) => s.source).sort(), ['a', 'b']);
  } finally { db.close(); }
});

test('DELETE removes one section; deleteDiarySections clears the whole day', async () => {
  const { db, app } = setup();
  try {
    await app.request(url('/api/diary/2026-10-09/sections/a'), put({ title: 'A', markdown: 'x' }), local);
    await app.request(url('/api/diary/2026-10-09/sections/b'), put({ title: 'B', markdown: 'y' }), local);
    assert.equal((await app.request(url('/api/diary/2026-10-09/sections/a'), { method: 'DELETE' }, local)).status, 200);
    assert.equal((await app.request(url('/api/diary/2026-10-09/sections/a'), { method: 'DELETE' }, local)).status, 404);
    assert.equal(listDiarySections(db, '2026-10-09').length, 1);
    assert.equal(deleteDiarySections(db, '2026-10-09'), 1);
    assert.equal(listDiarySections(db, '2026-10-09').length, 0);
  } finally { db.close(); }
});

test('inputs are bounded and writes stay local', async () => {
  const { db, app } = setup();
  try {
    const path = url('/api/diary/2026-10-09/sections/ok');
    assert.equal((await app.request(path, put({ title: 'x'.repeat(201), markdown: 'm' }), local)).status, 400);
    assert.equal((await app.request(path, put({ title: 't', markdown: 'x'.repeat(200 * 1024 + 1) }), local)).status, 400);
    assert.equal((await app.request(path, put({ title: 't', markdown: 'x'.repeat(200 * 1024) }), local)).status, 200);
    assert.equal((await app.request(path, put({ title: '', markdown: 'm' }), local)).status, 400);
    assert.equal((await app.request(url('/api/diary/2026-10-09/sections/Bad_Source'), put({ title: 't', markdown: 'm' }), local)).status, 400);
    assert.equal((await app.request(url('/api/diary/20261009/sections/ok'), put({ title: 't', markdown: 'm' }), local)).status, 400);
    assert.equal((await app.request(path, put({ title: 't', markdown: 'm' }), remote)).status, 403);
    assert.equal((await app.request(path, { method: 'DELETE' }, remote)).status, 403);
    const crossSite = { ...put({ title: 't', markdown: 'm' }), headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } };
    assert.equal((await app.request(path, crossSite, local)).status, 403);
  } finally { db.close(); }
});
