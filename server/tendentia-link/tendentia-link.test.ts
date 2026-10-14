import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hono } from 'hono';
import { loadTendentiaLink, makeTendentiaLinkRouter } from './router.js';
import { summarizeOverview } from './summary.js';

const overview = {
  lastCrawledAt: '2026-10-14T08:00:00.000Z',
  crossHits: [{ key: 'gemini', title: 'Gemini 4', sources: [{ name: 'HN' }, { name: 'はてブ' }] }],
  genres: [
    { genre: 'ai', label: 'AI', highlights: [{ title: 'Gemini 4', url: 'https://example.com/g', sourceName: 'HN', rank: 1, reasons: ['cross', 'new'] }], sources: [] },
    { genre: 'food', label: '食品', highlights: [], sources: [] },
    { genre: 'meme', label: 'ネットミーム', highlights: [{ title: 'x', url: 'javascript:alert(1)', sourceName: 'KYM', rank: 2, reasons: ['up'] }, { title: '' }], sources: [] },
  ],
};

test('要点は注目のあるジャンルだけを残し、 外部由来の URL は http(s) だけ通す', () => {
  const summary = summarizeOverview(overview);
  assert.equal(summary.lastCrawledAt, '2026-10-14T08:00:00.000Z');
  assert.deepEqual(summary.crossHits, [{ title: 'Gemini 4', sourceNames: ['HN', 'はてブ'] }]);
  assert.deepEqual(summary.genres.map((g) => [g.genre, g.highlights.length]), [['ai', 1], ['meme', 1]]);
  assert.equal(summary.genres[1].highlights[0].url, null);
  assert.throws(() => summarizeOverview(undefined), /overview/);
});

const okFetch = async (): Promise<Response> => new Response(JSON.stringify({ overview, busy: false }), { status: 200 });

test('接続先が無い・応答が異常・つながらないときは available: false と理由を返す', async () => {
  assert.deepEqual(await loadTendentiaLink({}), { available: false, openUrl: null, reason: 'Tendentia の接続先 (TENDENTIA_URL) が設定されていません' });
  const bad = await loadTendentiaLink({ baseUrl: 'http://127.0.0.1:4450', fetchImpl: async () => new Response('', { status: 503 }) });
  assert.equal(bad.available, false);
  assert.match(bad.available ? '' : bad.reason, /503/);
  const down = await loadTendentiaLink({ baseUrl: 'http://127.0.0.1:4450', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.match(down.available ? '' : down.reason, /ECONNREFUSED/);
});

test('開く URL は公開 URL を優先し、 無ければ接続先', async () => {
  const requested: string[] = [];
  const result = await loadTendentiaLink({
    baseUrl: 'http://127.0.0.1:4450/', publicUrl: 'https://tendentia.example.com',
    fetchImpl: async (url) => { requested.push(url); return okFetch(); },
  });
  assert.deepEqual(requested, ['http://127.0.0.1:4450/api/trend-crawler/overview']);
  assert.equal(result.openUrl, 'https://tendentia.example.com');
  assert.equal((await loadTendentiaLink({ baseUrl: 'http://127.0.0.1:4450', fetchImpl: okFetch })).openUrl, 'http://127.0.0.1:4450');
});

function requestFrom(app: Hono, address: string, url: string): Promise<Response> {
  return Promise.resolve(app.request(url, undefined, {
    incoming: { socket: { remoteAddress: address, remotePort: 12345, remoteFamily: 'IPv4' } },
  }));
}

test('API は同じ端末からだけ使える', async () => {
  const app = makeTendentiaLinkRouter({ baseUrl: 'http://127.0.0.1:4450', fetchImpl: okFetch });
  assert.equal((await requestFrom(app, '192.168.1.25', 'http://localhost/api/tendentia/summary')).status, 403);
  const response = await requestFrom(app, '127.0.0.1', 'http://localhost/api/tendentia/summary');
  assert.equal(response.status, 200);
  const body = await response.json() as { available: boolean };
  assert.equal(body.available, true);
});
