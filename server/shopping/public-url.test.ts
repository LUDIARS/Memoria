import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBlockedAddress } from '../shared/public-url.js';

test('内部IPv4を埋め込んだIPv6表現を遮断する', () => {
  for (const address of [
    '::ffff:7f00:1',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
  ]) {
    assert.equal(isBlockedAddress(address), true, `${address} は遮断されるべき`);
  }
});

test('公開IPv4を埋め込んだIPv6表現は許可する', () => {
  for (const address of ['::ffff:808:808', '::8.8.8.8']) {
    assert.equal(isBlockedAddress(address), false, `${address} は許可されるべき`);
  }
});
