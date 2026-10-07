import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { request, RequestOptions, IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { fetchPinnedPublicResponse, resolvePublicAddress } from './public-connection.js';
import { fetchPublicText } from './public-fetch.js';

test('内部 IPv4/IPv6/tailnet と混合 DNS 応答を拒否する', async () => {
  for (const host of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '100.100.100.100', '[::1]', '[fc00::1]', '[fe80::1]', '[fec0::1]', '[::ffff:127.0.0.1]', '[2002:7f00:1::1]']) {
    await assert.rejects(resolvePublicAddress(new URL(`http://${host}`)), /non-public/);
  }
  await assert.rejects(resolvePublicAddress(new URL('https://example.test'), async () => [
    { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 },
  ]), /non-public/);
  await assert.rejects(resolvePublicAddress(new URL('https://user:pass@example.test')), /credential-free/);
});

test('接続 lookup は検証済み IP を返し DNS を再解決しない、TLS hostname を保持する', async () => {
  let lookups = 0;
  let pinned: RequestOptions | undefined;
  const fakeRequest = ((url: URL, options: RequestOptions, onResponse: (res: IncomingMessage) => void) => {
    assert.equal(url.hostname, 'example.test');
    pinned = options;
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      const stream = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'text/html' } });
      onResponse(stream as unknown as IncomingMessage);
      stream.end('<title>normal bookmark</title>');
    };
    return req;
  }) as unknown as typeof request;
  const response = await fetchPinnedPublicResponse('https://example.test', {
    signal: new AbortController().signal, headers: {},
  }, { resolve: async () => [{ address: ++lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }], request: fakeRequest });
  assert.match(await response.text(), /normal bookmark/);
  assert.equal(lookups, 1);
  assert.equal(pinned?.agent, false);
  const lookup = pinned?.lookup as LookupFunction;
  lookup('example.test', {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
  });
  assert.equal(lookups, 1);
});

test('redirect の内部宛を接続前に拒否し、転送時の資格情報を除去する', async () => {
  let calls = 0;
  await assert.rejects(fetchPublicText('https://example.test', {}, async (url) => {
    await resolvePublicAddress(new URL(url), async () => [{ address: '8.8.8.8', family: 4 }]);
    calls += 1;
    return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/admin' } });
  }), /non-public/);
  assert.equal(calls, 1);
  const result = await fetchPublicText('https://example.test', { extraHeaders: { Authorization: 'fake' } }, async (url, options) => {
    if (url === 'https://example.test') return new Response(null, { status: 302, headers: { Location: 'https://other.test' } });
    assert.equal(options.headers.Authorization, undefined);
    return new Response('<title>public</title>', { headers: { 'Content-Type': 'text/html' } });
  });
  assert.match(result.text, /public/);
  await assert.rejects(fetchPublicText('https://example.test', { maxBytes: 3 }, async () => new Response('1234')), /too large/);
});
