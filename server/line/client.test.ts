// LINE push 送信と設定検証の単体テスト (実通信はしない)。

import '../tasks/test-backend.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { pushLineText, splitLineText, type FetchLike } from './client.js';
import { isValidLineTargetId, lineSettingsView, updateLineSettings } from './settings.js';

const TO = `U${'a'.repeat(32)}`;

test('push は Bearer トークンと text message を送る', async () => {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fake: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => '{}' };
  };
  const res = await pushLineText({ token: 'tok', to: TO, text: 'こんにちは' }, fake);
  assert.equal(res.ok, true);
  assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/push');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { to: TO, messages: [{ type: 'text', text: 'こんにちは' }] });
});

test('未設定なら通信せず理由を返す', async () => {
  let called = false;
  const fake: FetchLike = async () => { called = true; return { ok: true, status: 200, text: async () => '' }; };
  assert.equal((await pushLineText({ token: '', to: TO, text: 'x' }, fake)).ok, false);
  assert.equal((await pushLineText({ token: 't', to: '', text: 'x' }, fake)).ok, false);
  assert.equal(called, false);
});

test('LINE のエラー応答は status と本文を理由に含める', async () => {
  const fake: FetchLike = async () => ({ ok: false, status: 401, text: async () => '{"message":"Authentication failed"}' });
  const res = await pushLineText({ token: 'bad', to: TO, text: 'x' }, fake);
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.match(res.reason ?? '', /401.*Authentication failed/);
});

test('長文は上限で区切り、 改行があれば改行で切る', () => {
  const parts = splitLineText(`${'a'.repeat(8)}\n${'b'.repeat(8)}`, 10);
  assert.deepEqual(parts, ['a'.repeat(8), 'b'.repeat(8)]);
  assert.equal(splitLineText('x'.repeat(100), 10).length, 5);
});

test('設定はトークンを返さず、 送り先 ID の形を検証する', () => {
  const db = openDb(':memory:');
  try {
    assert.equal(isValidLineTargetId(TO), true);
    assert.equal(isValidLineTargetId('U123'), false);
    assert.equal(updateLineSettings(db, { to: 'not-an-id' }).ok, false);
    assert.equal(updateLineSettings(db, { token: ' secret ', to: TO }).ok, true);
    assert.deepEqual(lineSettingsView(db), { token_set: true, to: TO });
    // 空文字のトークンは据え置き
    updateLineSettings(db, { token: '' });
    assert.equal(lineSettingsView(db).token_set, true);
    updateLineSettings(db, { clearToken: true });
    assert.equal(lineSettingsView(db).token_set, false);
  } finally {
    db.close();
  }
});
