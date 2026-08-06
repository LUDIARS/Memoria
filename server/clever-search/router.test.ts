import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { hostname } from 'node:os';
import { Hono } from 'hono';
import { openDb } from '../db.js';
import type { CleverSearchResponse } from '../api/types/clever-search.js';
import { makeCleverSearchRouter } from './router.js';
import { normalizeCleverSearchQuery, searchCleverDocuments } from './store.js';

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

function sourceContent(
  db: ReturnType<typeof openDb>,
  sourceType: string,
  sourceId: string | number,
): string {
  const row = db.prepare(`
    SELECT content FROM clever_search_sources
     WHERE source_type = ? AND source_id = ?
  `).get(sourceType, String(sourceId)) as { content: string } | undefined;
  assert.ok(row, `expected ${sourceType}#${sourceId} in clever search projection`);
  return row.content;
}

function hitCount(db: ReturnType<typeof openDb>, query: string): number {
  return searchCleverDocuments(db, normalizeCleverSearchQuery(query)).length;
}

test('clever search groups sources, preserves all citations, and caches reports', async () => {
  const db = openDb(':memory:');
  try {
    const insertActivity = db.prepare(`
      INSERT INTO activity_events (kind, occurred_at, source, content)
      VALUES ('git_commit', ?, 'Memoria', ?)
    `);
    const insertMany = db.transaction(() => {
      for (let index = 0; index < 12; index += 1) {
        insertActivity.run(`2026-08-${String(index + 1).padStart(2, '0')} 01:00:00`, `クレバーサーチ 実装 ${index}`);
      }
    });
    insertMany();
    db.prepare(`
      INSERT INTO external_chat_messages (source, role, content, received_at)
      VALUES ('manual', 'user', 'クレバーサーチ の相談', '2026-08-01 02:00:00')
    `).run();

    const app = new Hono();
    app.route('/', makeCleverSearchRouter({ db, random: () => 0.5 }));

    const first = await requestFrom(app, '127.0.0.1', 'http://localhost/api/clever-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
      body: JSON.stringify({ query: 'クレバーサーチ' }),
    });
    assert.equal(first.status, 200);
    const created = await first.json() as CleverSearchResponse;
    assert.equal(created.cached, false);
    assert.equal(created.report.totalHits, 13);
    assert.deepEqual(created.report.categories.map((category) => category.key), ['development', 'conversation']);
    assert.equal(created.report.categories[0].representatives.length, 5);
    assert.equal(created.report.categories[0].citations.length, 12);

    const second = await requestFrom(app, '::ffff:127.0.0.1', 'http://localhost/api/clever-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '  クレバーサーチ  ' }),
    });
    const cached = await second.json() as CleverSearchResponse;
    assert.equal(cached.cached, true);
    assert.equal(cached.reportId, created.reportId);

    const refreshed = await requestFrom(app, '127.0.0.1', 'http://127.0.0.1/api/clever-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'クレバーサーチ', refresh: true }),
    });
    const rebuilt = await refreshed.json() as CleverSearchResponse;
    assert.equal(rebuilt.cached, false);
    assert.notEqual(rebuilt.reportId, created.reportId);
  } finally {
    db.close();
  }
});

test('clever search index follows source and related-row mutations', () => {
  const db = openDb(':memory:');
  try {
    makeCleverSearchRouter({ db });

    db.prepare(`
      INSERT INTO diary_entries (date, summary)
      VALUES ('2026-08-01', '同期前の日記')
    `).run();
    assert.match(sourceContent(db, 'diary', '2026-08-01'), /同期前の日記/);
    assert.equal(hitCount(db, '同期前'), 1);

    db.prepare(`
      UPDATE diary_entries
         SET date = '2026-08-02', summary = '同期後の日記'
       WHERE date = '2026-08-01'
    `).run();
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS count FROM clever_search_sources
         WHERE source_type = 'diary' AND source_id = '2026-08-01'
      `).get() as { count: number }).count,
      0,
    );
    assert.match(sourceContent(db, 'diary', '2026-08-02'), /同期後の日記/);
    assert.equal(hitCount(db, '同期前'), 0);
    assert.equal(hitCount(db, '同期後'), 1);

    db.prepare("DELETE FROM diary_entries WHERE date = '2026-08-02'").run();
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS count FROM clever_search_sources
         WHERE source_type = 'diary'
      `).get() as { count: number }).count,
      0,
    );
    assert.equal(hitCount(db, '同期後'), 0);

    const bookmarkId = Number(db.prepare(`
      INSERT INTO bookmarks (url, title, html_path)
      VALUES ('https://example.test', '関連行テスト', '')
    `).run().lastInsertRowid);
    db.prepare(`
      INSERT INTO bookmark_categories (bookmark_id, category)
      VALUES (?, '追加カテゴリ')
    `).run(bookmarkId);
    assert.match(sourceContent(db, 'bookmark', bookmarkId), /追加カテゴリ/);
    assert.equal(hitCount(db, '追加カテゴリ'), 1);
    db.prepare(`
      UPDATE bookmark_categories SET category = '更新カテゴリ'
       WHERE bookmark_id = ? AND category = '追加カテゴリ'
    `).run(bookmarkId);
    assert.match(sourceContent(db, 'bookmark', bookmarkId), /更新カテゴリ/);
    assert.equal(hitCount(db, '追加カテゴリ'), 0);
    assert.equal(hitCount(db, '更新カテゴリ'), 1);
    db.prepare(`
      DELETE FROM bookmark_categories
       WHERE bookmark_id = ? AND category = '更新カテゴリ'
    `).run(bookmarkId);
    assert.doesNotMatch(sourceContent(db, 'bookmark', bookmarkId), /更新カテゴリ/);
    assert.equal(hitCount(db, '更新カテゴリ'), 0);

    db.prepare(`
      INSERT INTO notes (id, title) VALUES ('trigger-note', '関連行テスト')
    `).run();
    db.prepare(`
      INSERT INTO note_blocks (uuid, note_id, position, text)
      VALUES ('trigger-block', 'trigger-note', 10, '追加ブロック')
    `).run();
    assert.match(sourceContent(db, 'note', 'trigger-note'), /追加ブロック/);
    assert.equal(hitCount(db, '追加ブロック'), 1);
    db.prepare(`
      INSERT INTO note_blocks (uuid, note_id, position, text)
      VALUES ('earlier-block', 'trigger-note', 0, '先頭ブロック')
    `).run();
    const orderedNoteContent = sourceContent(db, 'note', 'trigger-note');
    assert.ok(
      orderedNoteContent.indexOf('先頭ブロック') < orderedNoteContent.indexOf('追加ブロック'),
      'note blocks should be projected in position order',
    );
    db.prepare("UPDATE note_blocks SET text = '更新ブロック' WHERE uuid = 'trigger-block'").run();
    assert.match(sourceContent(db, 'note', 'trigger-note'), /更新ブロック/);
    assert.equal(hitCount(db, '追加ブロック'), 0);
    assert.equal(hitCount(db, '更新ブロック'), 1);
    db.prepare("DELETE FROM note_blocks WHERE uuid = 'trigger-block'").run();
    assert.doesNotMatch(sourceContent(db, 'note', 'trigger-note'), /更新ブロック/);
    assert.equal(hitCount(db, '更新ブロック'), 0);

    db.prepare(`
      INSERT INTO bookmark_categories (bookmark_id, category)
      VALUES (?, 'cascade-bookmark-marker')
    `).run(bookmarkId);
    db.prepare('DELETE FROM bookmarks WHERE id = ?').run(bookmarkId);
    assert.equal(
      db.prepare(`
        SELECT 1 FROM clever_search_sources
         WHERE source_type = ? AND source_id = ?
      `).get('bookmark', String(bookmarkId)),
      undefined,
    );
    assert.equal(hitCount(db, 'cascade-bookmark-marker'), 0);

    db.prepare("UPDATE note_blocks SET text = 'cascade-note-marker' WHERE uuid = 'earlier-block'").run();
    db.prepare("DELETE FROM notes WHERE id = 'trigger-note'").run();
    assert.equal(
      db.prepare(`
        SELECT 1 FROM clever_search_sources
         WHERE source_type = ? AND source_id = ?
      `).get('note', 'trigger-note'),
      undefined,
    );
    assert.equal(hitCount(db, 'cascade-note-marker'), 0);
  } finally {
    db.close();
  }
});

test('clever search startup keeps an existing projection instead of rebuilding every source', () => {
  const db = openDb(':memory:');
  try {
    db.prepare(`
      INSERT INTO activity_events (kind, occurred_at, source, content)
      VALUES ('codex_prompt', '2026-08-06 00:00:00', 'startup-fixture', 'original source')
    `).run();
    makeCleverSearchRouter({ db });
    db.prepare(`
      UPDATE clever_search_sources
         SET content = 'existing projection sentinel'
       WHERE source_type = 'activity'
    `).run();

    makeCleverSearchRouter({ db });

    assert.equal(
      sourceContent(db, 'activity', 1),
      'existing projection sentinel',
    );
  } finally {
    db.close();
  }
});

test('clever search returns ten thousand FTS and short-query citations within five seconds', async () => {
  const db = openDb(':memory:');
  try {
    const app = new Hono();
    app.route('/', makeCleverSearchRouter({ db, random: () => 0.25 }));
    const insert = db.prepare(`
      INSERT INTO activity_events (kind, occurred_at, source, content)
      VALUES ('codex_prompt', ?, 'performance-fixture', ?)
    `);
    db.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        insert.run('2026-08-06 00:00:00', `性能境界 の検索ログ ${index}`);
      }
    })();

    for (const query of ['性能境界', '性能']) {
      const startedAt = performance.now();
      const response = await requestFrom(app, '127.0.0.1', 'http://localhost/api/clever-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const elapsedMs = performance.now() - startedAt;
      const payload = await response.json() as CleverSearchResponse;

      assert.equal(response.status, 200);
      assert.equal(payload.report.totalHits, 10_000);
      assert.equal(payload.report.categories[0].citations.length, 10_000);
      assert.ok(
        elapsedMs < 5_000,
        `expected query=${query} < 5000ms, received ${Math.round(elapsedMs)}ms`,
      );
      assert.ok(payload.retrievalElapsedMs < 5_000);
    }
  } finally {
    db.close();
  }
});

test('clever search accepts this machine and rejects remote, arbitrary-host, and cross-origin access', async () => {
  const db = openDb(':memory:');
  try {
    const app = new Hono();
    app.route('/', makeCleverSearchRouter({ db }));

    const remoteSearch = await requestFrom(app, '192.168.1.25', 'http://memoria.lan/api/clever-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'private log' }),
    });
    assert.equal(remoteSearch.status, 403);
    assert.equal(remoteSearch.headers.get('Cache-Control'), 'no-store');

    const remoteHistory = await requestFrom(
      app,
      '10.0.0.2',
      'http://memoria.lan/api/clever-search/reports',
    );
    assert.equal(remoteHistory.status, 403);

    const remoteReport = await requestFrom(
      app,
      '10.0.0.2',
      'http://memoria.lan/api/clever-search/reports/1',
    );
    assert.equal(remoteReport.status, 403);

    const crossSiteHistory = await requestFrom(
      app,
      '127.0.0.1',
      'http://localhost/api/clever-search/reports',
      { headers: { Origin: 'https://attacker.example' } },
    );
    assert.equal(crossSiteHistory.status, 403);

    const machineOrigin = `http://${hostname()}`;
    const machineHistory = await requestFrom(
      app,
      '127.0.0.1',
      `${machineOrigin}/api/clever-search/reports`,
      { headers: { Origin: machineOrigin } },
    );
    assert.equal(machineHistory.status, 200);

    const reboundHistory = await requestFrom(
      app,
      '127.0.0.1',
      'http://attacker.example/api/clever-search/reports',
      { headers: { Origin: 'http://attacker.example' } },
    );
    assert.equal(reboundHistory.status, 403);

    const accessHistory = await requestFrom(
      app,
      '127.0.0.1',
      'http://memoria.ai-run-do.com/api/clever-search/reports',
      {
        headers: {
          Origin: 'https://memoria.ai-run-do.com',
          'X-Forwarded-Proto': 'https',
        },
      },
    );
    assert.equal(accessHistory.status, 200);

    const localHistory = await requestFrom(
      app,
      '127.0.0.1',
      'http://localhost/api/clever-search/reports',
      { headers: { Origin: 'http://localhost' } },
    );
    assert.equal(localHistory.status, 200);
  } finally {
    db.close();
  }
});

test('clever search privacy middleware does not affect unrelated routes', async () => {
  const db = openDb(':memory:');
  try {
    const app = new Hono();
    app.route('/', makeCleverSearchRouter({ db }));
    app.get('/api/unrelated', (c) => c.json({ ok: true }));

    const response = await requestFrom(app, '192.168.1.25', 'http://memoria.lan/api/unrelated');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), null);
  } finally {
    db.close();
  }
});

test('clever search report history validates limit as an integer from one to one hundred', async () => {
  const db = openDb(':memory:');
  try {
    const app = new Hono();
    app.route('/', makeCleverSearchRouter({ db }));

    for (const limit of ['1.5', 'abc', '0', '101', '-1']) {
      const response = await requestFrom(
        app,
        '127.0.0.1',
        `http://localhost/api/clever-search/reports?limit=${encodeURIComponent(limit)}`,
      );
      assert.equal(response.status, 400, `expected limit=${limit} to be rejected`);
    }

    const maximum = await requestFrom(
      app,
      '127.0.0.1',
      'http://localhost/api/clever-search/reports?limit=100',
    );
    assert.equal(maximum.status, 200);
  } finally {
    db.close();
  }
});

test('clever search validates query input and treats LIKE metacharacters literally', async () => {
  const db = openDb(':memory:');
  try {
    const app = new Hono();
    app.route('/', makeCleverSearchRouter({ db }));
    db.prepare(`
      INSERT INTO activity_events (kind, occurred_at, source, content)
      VALUES ('test', '2026-08-06 00:00:00', 'query-fixture', 'literal %_ marker')
    `).run();
    db.prepare(`
      INSERT INTO activity_events (kind, occurred_at, source, content)
      VALUES ('test', '2026-08-06 00:00:01', 'query-fixture', 'wildcard control')
    `).run();

    assert.equal(hitCount(db, '%_'), 1);
    assert.equal(hitCount(db, "%' OR 1=1 --"), 0);

    for (const body of [
      {},
      { query: 'x'.repeat(121) },
      { query: 'valid query', refresh: 'yes' },
    ]) {
      const response = await requestFrom(app, '127.0.0.1', 'http://localhost/api/clever-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
  } finally {
    db.close();
  }
});
