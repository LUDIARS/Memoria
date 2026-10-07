import '../tasks/test-backend.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, setAppSettings } from '../db.js';
import { FifoQueue } from '../queue.js';
import { makeBookmarkRouter } from './bookmark.js';
import { makeConfigRouter } from './config.js';

test('通常の bookmark 保存を維持し、保存 HTML と LLM 設定の境界を適用する', async () => {
  const db = openDb(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'memoria-security-test-'));
  const queue = new FifoQueue();
  const priorToken = process.env.MEMORIA_BOOKMARK_TOKEN;
  process.env.MEMORIA_BOOKMARK_TOKEN = 'fake-ingestion';
  let fetched = 0;
  try {
    setAppSettings(db, { 'features.bookmarks.auto_summarize': '0' });
    const bookmarks = makeBookmarkRouter({ db, htmlDir: directory, summaryQueue: queue, enqueueSummary: () => {},
      fetchPageHtml: async () => { fetched += 1; return { title: 'public', html: '<p>public</p>' }; } });
    const headers = { 'Content-Type': 'application/json', 'X-Memoria-Bookmark-Token': 'fake-ingestion' };
    const denied = await bookmarks.request('/api/bookmarks/from-url', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"url":"https://example.test"}',
    });
    assert.equal(denied.status, 403);
    assert.equal(fetched, 0);
    const saved = await bookmarks.request('/api/bookmark', { method: 'POST', headers,
      body: JSON.stringify({ url: 'https://example.test', title: 'test', html: '<script>fetch("/api/llm/config")</script>' }) });
    assert.equal(saved.status, 200);
    const { id } = await saved.json() as { id: number };
    const html = await bookmarks.request(`/api/bookmarks/${id}/html`);
    const csp = html.headers.get('Content-Security-Policy') ?? '';
    assert.match(csp, /(?:^|;)\s*sandbox;/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.doesNotMatch(csp, /allow-scripts|allow-same-origin/);
    assert.equal(html.headers.get('Cache-Control'), 'no-store');
    const duplicate = await bookmarks.request('/api/bookmark', { method: 'POST', headers,
      body: JSON.stringify({ url: 'https://example.test', html: '<p>duplicate</p>' }) });
    assert.equal((await duplicate.json() as { duplicate: boolean }).duplicate, true);
    const fromUrl = await bookmarks.request('/api/bookmarks/from-url', { method: 'POST', headers,
      body: '{"url":"https://other.test"}' });
    assert.equal(fromUrl.status, 201);
    assert.equal(fetched, 1);
    const config = makeConfigRouter({ db, port: 1, dataDir: directory, onMcpAutostartChange: () => {},
      onActivitySettingsChange: () => {}, summaryQueue: queue, cloudQueue: queue, digQueue: queue,
      diaryQueue: queue, weeklyQueue: queue, domainCatalogQueue: queue, pageMetadataQueue: queue, mealVisionQueue: queue });
    const deniedConfig = await config.request('/api/llm/config', { method: 'PATCH', headers,
      body: '{"bins":{"claude":"attacker"}}' });
    assert.equal(deniedConfig.status, 403);
  } finally {
    if (priorToken === undefined) delete process.env.MEMORIA_BOOKMARK_TOKEN;
    else process.env.MEMORIA_BOOKMARK_TOKEN = priorToken;
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
