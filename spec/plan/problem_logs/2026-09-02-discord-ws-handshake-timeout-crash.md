# Memoria server crash from unhandled Discord gateway handshake timeout

- Date: 2026-09-02 (incident window: around 2026-08-11..2026-08-26)
- Status: fixed (process guard + regression test)
- Area: server runtime / Discord integration
- Severity: high — the whole Memoria server process exits; Discord integration
  was left disabled as a stopgap afterwards

## Summary

During a network outage, Discord REST calls repeatedly timed out and the gateway
entered a reconnect loop. While reconnecting, an orphaned WebSocket raised
`Error: Opening handshake has timed out`, which was emitted as an unhandled
`'error'` event and terminated the entire Memoria server process.

This is the second server-wide outage caused by the Discord integration
(the first: 2026-07-15 discord.js version mismatch at startup). The Discord
integration is documented as best-effort and must never stop the Memoria server.

## Evidence

- Service stderr showed a long run of
  `[discord] monitor update 失敗: Connect Timeout Error (attempted address: discord.com:443 ...)`
  followed by:
  `node:events: throw er; // Unhandled 'error' event` /
  `Error: Opening handshake has timed out` at `ws/lib/websocket.js`,
  `Emitted 'error' event on WebSocket instance`.
- After the crash, `features.discord.enabled` was set to `false` and all
  Discord daily posts (`news_last_sent` etc.) stopped updating.

## Cause

`@discordjs/ws` `WebSocketShard.destroy()` clears the socket's error handler
(`connection.onerror = null`) before recovery reconnect. When the shard is
destroyed while the old socket is still in its opening handshake (typical during
a network outage), the later handshake timeout fires on a socket that no longer
has any `'error'` listener. Node then treats it as an unhandled `'error'` event
and kills the process. No process-level guard existed to contain
Discord-transport failures.

## Fix

- `server/discord/process-guard.ts`: install a `process.on('uncaughtException')`
  guard when the Discord bot starts. Errors classified as Discord/ws transport
  failures (a known transport message together with a ws-internal stack frame)
  are logged and swallowed; the `@discordjs/ws` reconnect loop can continue.
  All other uncaught exceptions keep the previous fail-fast behavior (log +
  exit 1), including `EADDRINUSE` and unknown programming errors raised inside
  ws callbacks.

## Regression Test

`server/discord/process-guard.test.ts`:

- classifier unit tests (transport errors detected only when both the known
  message and ws origin match; `EADDRINUSE`, unknown ws errors, and non-Error
  values stay fatal), and
- a child-process reproduction using the real `ws` package: a TCP server that
  never answers the handshake plus a socket whose `onerror` is detached the same
  way `WebSocketShard.destroy()` does. Without the guard the child crashes with
  the production error; with the guard it survives.

## Verification

- `node --import tsx --test discord/process-guard.test.ts` includes the crash
  reproduction and classifier boundary cases.
- Backend and frontend `tsc --noEmit` pass.
- After deploy: re-enable `features.discord.enabled`, restart the service
  through its service manager, and confirm the bot logs in and the health
  endpoint stays up.

## Follow-up

- Consider upgrading `@discordjs/ws` when an upstream fix for the
  destroy-during-handshake listener gap is available; the guard stays valid
  either way as an isolation boundary for the best-effort integration.
