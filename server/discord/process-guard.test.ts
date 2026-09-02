// Discord transport crash guard の回帰テスト。
//
// 2026-08 障害: ネットワーク断中の gateway 再接続で ws の
// `Opening handshake has timed out` が unhandled 'error' event になり
// Memoria server 全体が落ちた (2026-07-15 の discord.js 版数不整合に続く
// Discord 起因のサーバ全落ち 2 件目)。
// ここでは (1) 判定関数の分類、(2) 実 ws での crash 再現と guard による生存、
// を子プロセスで検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isDiscordTransportError } from './process-guard.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, '..');

function wsError(message: string, path = '/app/node_modules/ws/lib/websocket.js'): Error {
  const err = new Error(message);
  err.stack = `Error: ${message}\n    at WebSocket.emit (${path}:890:7)`;
  return err;
}

test('isDiscordTransportError: handshake timeout は transport 由来', () => {
  assert.equal(isDiscordTransportError(wsError('Opening handshake has timed out')), true);
});

test('isDiscordTransportError: 接続確立前 close も transport 由来', () => {
  assert.equal(
    isDiscordTransportError(wsError(
      'WebSocket was closed before the connection was established',
      'E:\\app\\node_modules\\ws\\lib\\websocket.js',
    )),
    true,
  );
});

test('isDiscordTransportError: 不正 frame は詳細付きメッセージも transport 由来', () => {
  assert.equal(
    isDiscordTransportError(wsError(
      'Invalid WebSocket frame: invalid opcode 3',
      '/app/node_modules/ws/lib/receiver.js',
    )),
    true,
  );
});

test('isDiscordTransportError: ws 内部でも未知のエラーは対象外', () => {
  const err = new Error('unexpected transport failure');
  err.stack = `Error: unexpected transport failure\n    at ClientRequest.<anonymous> (E:\\x\\node_modules\\ws\\lib\\websocket.js:890:7)`;
  assert.equal(isDiscordTransportError(err), false);
});

test('isDiscordTransportError: 既知メッセージでも ws 外部なら対象外', () => {
  assert.equal(isDiscordTransportError(new Error('Opening handshake has timed out')), false);
});

test('isDiscordTransportError: EADDRINUSE 等の非 Discord エラーは対象外', () => {
  const err = new Error('listen EADDRINUSE: address already in use :::5180');
  err.stack = `Error: listen EADDRINUSE: address already in use :::5180\n    at Server.setupListenHandle [as _listen2] (node:net:1948:16)`;
  assert.equal(isDiscordTransportError(err), false);
});

test('isDiscordTransportError: Error 以外は対象外', () => {
  assert.equal(isDiscordTransportError('Opening handshake has timed out'), false);
  assert.equal(isDiscordTransportError(null), false);
});

interface ReproResult { code: number | null; stdout: string; stderr: string; }

function runRepro(mode: 'no-guard' | 'with-guard'): Promise<ReproResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(here, 'process-guard.crash-repro.ts'), mode],
      { cwd: serverRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    const killTimer = setTimeout(() => {
      child.kill();
      reject(new Error(`repro (${mode}) timed out. stdout=${stdout} stderr=${stderr}`));
    }, 20_000);
    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (e) => { clearTimeout(killTimer); reject(e); });
  });
}

test('guard なし: 孤児 ws の handshake timeout でプロセスが落ちる (障害の再現)', async () => {
  const r = await runRepro('no-guard');
  assert.notEqual(r.code, 0, `expected crash but exited 0. stdout=${r.stdout}`);
  assert.match(r.stderr, /Opening handshake has timed out/);
});

test('guard あり: 同じ状況でもプロセスが生存する', async () => {
  const r = await runRepro('with-guard');
  assert.equal(r.code, 0, `expected survival. stderr=${r.stderr}`);
  assert.match(r.stdout, /SURVIVED/);
});
