import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feedPinnedEvidence } from '../../augur/probes/pinned-retrieval.js';
import { fetchFeedXml } from './sources.js';
import { BlockedUrlError } from './url-guard.js';
import { extractFeedTitle, extractFeedLinks } from './discovery-markup.js';

test('フィード title の CDATA・空白・大文字タグ・200文字制限を維持する', () => {
  assert.equal(extractFeedTitle('<rss><TITLE lang="ja"><![CDATA[  Feed\n title  ]]></TITLE></rss>'), 'Feed title');
  assert.equal(extractFeedTitle(`<feed><title>${'a'.repeat(201)}</title></feed>`), 'a'.repeat(200));
  assert.equal(extractFeedTitle('<rss><title></title></rss>'), '');
  assert.equal(extractFeedTitle('<feed/>'), null);
  assert.equal(extractFeedTitle('<title no-end'), null);
  assert.equal(extractFeedTitle('<title>İ Mixed CASE</TITLE>'), 'İ Mixed CASE');
});

test('HTML の RSS・Atomリンク判定、絶対化、重複除去とタイトルを維持する', () => {
  const body = `
    <link rel="alternate" type="application/rss+xml" href="/rss" title="  News  ">
    <LINK TYPE='application/atom+xml' REL=alternate HREF='atom.xml' TITLE='Atom'>
    <link rel="alternate" type="application/rss+xml" href="https://example.test/rss" title="duplicate">
    <link rel="stylesheet" type="application/rss+xml" href="/wrong-rel">
    <link rel="alternate" type="text/html" href="/wrong-type">
    <link rel="alternate" type="application/rss+xml" href="http://[">
    <link rel="alternate" type="application/rss+xml">
    <link rel="alternate" type="application/rss+xml" href="/untitled">
    <link rel="alternate" type="application/rss+xml" href="/long" title="${'x'.repeat(201)}">
  `;
  assert.deepEqual(extractFeedLinks(body, 'https://example.test/page/'), [
    { url: 'https://example.test/rss', title: 'News' },
    { url: 'https://example.test/page/atom.xml', title: 'Atom' },
    { url: 'https://example.test/untitled', title: null },
    { url: 'https://example.test/long', title: 'x'.repeat(200) },
  ]);
  assert.deepEqual(extractFeedLinks('<linkage rel="alternate" type="application/rss+xml" href="/wrong">', 'https://example.test/'), []);
});

test('閉じない title の256KiB入力を1秒未満で処理する', (t) => {
  const body = '<title>'.repeat(Math.ceil(256 * 1024 / 7));
  const start = performance.now();
  assert.equal(extractFeedTitle(body), null);
  const elapsed = performance.now() - start;
  t.diagnostic(`title: ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 1000, `title scan took ${elapsed} ms`);
});

test('閉じない link の256KiB入力を1秒未満で処理する', (t) => {
  const body = '<link '.repeat(Math.ceil(256 * 1024 / 6));
  const start = performance.now();
  assert.deepEqual(extractFeedLinks(body, 'https://example.test/'), []);
  const elapsed = performance.now() - start;
  t.diagnostic(`link: ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 1000, `link scan took ${elapsed} ms`);
});

test('RSS は各 hop の検査済み IP に接続を固定し DNS を再解決しない', async () => {
  const evidence = await feedPinnedEvidence();
  assert.deepEqual(evidence.resolutions, ['first.test', 'second.test']);
  assert.deepEqual(evidence.connections.map((connection) => connection.address), ['8.8.8.8', '1.1.1.1']);
  assert.ok(evidence.connections.every((connection) => connection.identity));
  assert.equal(evidence.bodyMatches, true);
});

test('RSS は不正 URL・内部アドレス・非 HTTP URL を BlockedUrlError で拒否する', async () => {
  for (const url of ['not a url', 'http://127.0.0.1/feed', 'file:///feed']) {
    await assert.rejects(fetchFeedXml(url), BlockedUrlError);
  }
});

test('RSS は DNS 失敗を BlockedUrlError で返す', async () => {
  await assert.rejects(fetchFeedXml('https://missing.test', 20_000, {
    resolve: async () => { throw Object.assign(new Error('not found'), { syscall: 'getaddrinfo' }); },
  }), BlockedUrlError);
});
