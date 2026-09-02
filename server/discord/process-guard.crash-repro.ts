// process-guard.test.ts 専用の再現フィクスチャ (単体起動用、server 本体からは import しない)。
//
// 2026-08 障害の再現: @discordjs/ws の WebSocketShard.destroy() と同じく
// onerror を張った後 null へ戻した WebSocket が handshake timeout すると、
// unhandled 'error' event でプロセスが落ちる。
// argv[2] = 'with-guard' なら installDiscordProcessGuard() を入れて生存を確認する。

import { createServer } from 'node:net';
import WebSocket from 'ws';
import { installDiscordProcessGuard } from './process-guard.js';

const mode = process.argv[2] ?? 'no-guard';
if (mode === 'with-guard') installDiscordProcessGuard();

// handshake に一切応答しない TCP サーバ (= ネットワーク断で応答が返らない状況)
const srv = createServer(() => { /* accept して放置 */ });
srv.listen(0, '127.0.0.1', () => {
  const addr = srv.address();
  if (addr === null || typeof addr === 'string') throw new Error('unexpected listen address');
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}`, [], { handshakeTimeout: 150 });
  // WebSocketShard.destroy() の挙動を再現: onerror を外して孤児化させる
  ws.onerror = () => { /* attach */ };
  ws.onerror = null;
  setTimeout(() => {
    // handshake timeout (150ms) を生き延びたらここへ到達する
    console.log('SURVIVED');
    process.exit(0);
  }, 800);
});
