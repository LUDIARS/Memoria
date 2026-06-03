// SSRF guard の単体テスト (node:test / 追加依存なし)。
// 実行: server/ で `npm test` (= node --import tsx --test rss/url-guard.test.ts)
//
// ネットワーク (DNS) に依存しないよう、IP リテラル + スキーム経路のみを検証する。
// ホスト名解決経路は isBlockedAddress (純粋) の網羅でカバーする。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedAddress, assertFetchableFeedUrl, BlockedUrlError } from './url-guard.js';

test('isBlockedAddress: internal/予約レンジを遮断', () => {
  const blocked = [
    '127.0.0.1', '127.1.2.3',          // loopback
    '10.0.0.1', '10.255.255.255',      // private A
    '172.16.0.1', '172.31.255.255',    // private B
    '192.168.0.1', '192.168.255.255',  // private C
    '169.254.169.254',                 // link-local (cloud metadata)
    '100.64.0.1',                      // CGNAT
    '0.0.0.0',                         // this network
    '224.0.0.1',                       // multicast
    '255.255.255.255',                 // broadcast/reserved
    '198.18.0.1',                      // benchmarking
    '::1', '::',                       // IPv6 loopback / unspecified
    'fc00::1', 'fd12:3456::1',         // ULA
    'fe80::1',                         // link-local
    '::ffff:127.0.0.1',                // IPv4-mapped loopback
    '::ffff:10.0.0.1',                 // IPv4-mapped private
  ];
  for (const ip of blocked) {
    assert.equal(isBlockedAddress(ip), true, `${ip} は遮断されるべき`);
  }
});

test('isBlockedAddress: public アドレスは許可', () => {
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2001:4860:4860::8888'];
  for (const ip of allowed) {
    assert.equal(isBlockedAddress(ip), false, `${ip} は許可されるべき`);
  }
});

test('isBlockedAddress: IP でない文字列は安全側で遮断', () => {
  assert.equal(isBlockedAddress('example.com'), true);
  assert.equal(isBlockedAddress('not-an-ip'), true);
});

test('assertFetchableFeedUrl: 非 http(s) スキームを拒否', async () => {
  for (const u of ['ftp://example.com/x', 'file:///etc/passwd', 'gopher://x/', 'data:text/plain,hi']) {
    await assert.rejects(() => assertFetchableFeedUrl(u), BlockedUrlError, `${u} は拒否されるべき`);
  }
});

test('assertFetchableFeedUrl: internal IP リテラルを拒否', async () => {
  const urls = [
    'http://127.0.0.1/feed',
    'http://10.0.0.5:8080/rss',
    'http://192.168.1.1/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/feed',
    'https://[fd00::1]/rss',
  ];
  for (const u of urls) {
    await assert.rejects(() => assertFetchableFeedUrl(u), BlockedUrlError, `${u} は拒否されるべき`);
  }
});

test('assertFetchableFeedUrl: public IP リテラルは許可 (DNS 不要)', async () => {
  await assert.doesNotReject(() => assertFetchableFeedUrl('http://8.8.8.8/feed'));
  await assert.doesNotReject(() => assertFetchableFeedUrl('https://1.1.1.1/rss'));
});

test('assertFetchableFeedUrl: 不正 URL を拒否', async () => {
  await assert.rejects(() => assertFetchableFeedUrl('not a url'), BlockedUrlError);
});
