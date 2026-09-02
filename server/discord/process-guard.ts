// Discord transport 起因の uncaughtException から Memoria server を守るガード。
//
// 背景 (2026-08 障害): ネットワーク断中の gateway 再接続で @discordjs/ws の
// WebSocketShard.destroy() が connection.onerror を null にした後、孤児化した
// WebSocket の handshake timeout が unhandled 'error' event になりプロセスごと
// 落ちた (`Error: Opening handshake has timed out` @ ws/lib/websocket.js)。
// Discord は best-effort 機能であり、transport 失敗で server 全体を殺さない。
//
// 方針: uncaughtException のうち「Discord/ws transport 由来」と判定できるもの
// だけを log して握りつぶす。それ以外は従来どおり fail-fast (exit 1)。

const EXACT_TRANSPORT_MESSAGES = [
  'Opening handshake has timed out',
  'WebSocket was closed before the connection was established',
];

const TRANSPORT_MESSAGE_PREFIXES = [
  'Invalid WebSocket frame:',
];

const TRANSPORT_STACK_MARKERS = [
  // path 区切りは OS で変わるため両方見る
  'node_modules/ws/lib/',
  'node_modules\\ws\\lib\\',
  '@discordjs/ws',
  '@discordjs\\ws',
];

/** uncaughtException が Discord/ws transport 由来かを判定する。 */
export function isDiscordTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message ?? '';
  const hasKnownMessage = EXACT_TRANSPORT_MESSAGES.includes(message)
    || TRANSPORT_MESSAGE_PREFIXES.some((prefix) => message.startsWith(prefix));
  if (!hasKnownMessage) return false;
  const stack = err.stack ?? '';
  return TRANSPORT_STACK_MARKERS.some((m) => stack.includes(m));
}

let installed = false;

/**
 * process レベルのガードを 1 回だけ入れる。 Discord Bot 起動時に呼ぶ。
 * transport 由来の uncaughtException は warn ログのみで生存継続
 * (@discordjs/ws 側の再接続ループは生きているため回復はそちらに任せる)。
 * それ以外の uncaughtException は既定挙動と同じく stderr + exit 1。
 */
export function installDiscordProcessGuard(): void {
  if (installed) return;
  installed = true;
  process.on('uncaughtException', (err: Error) => {
    if (isDiscordTransportError(err)) {
      console.warn(`[discord] transport error を握りつぶして継続: ${err.message}`);
      return;
    }
    console.error(err);
    process.exit(1);
  });
}
