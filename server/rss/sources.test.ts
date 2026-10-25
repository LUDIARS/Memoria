import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feedPinnedEvidence } from '../../augur/probes/pinned-retrieval.js';
import { fetchFeedXml } from './sources.js';
import { BlockedUrlError } from './url-guard.js';

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
