#!/usr/bin/env node
// Codex CLI UserPromptSubmit hook → Memoria activity event.
//
// Claude Code 用の claude-code-prompt.mjs と対になる Codex 版。 Codex CLI には
// Claude Code のような UserPromptSubmit hook 由来の Memoria 記録経路が無く、
// codex への指示が Memoria に残らなかった (kind=codex_prompt は DB/API 的には
// 既にサポート済だが、 投げ込む hook が存在しなかった)。 本スクリプトがその
// 隙間を埋める。
//
// stdin から Codex の hook payload (prompt / session_id / cwd ... の JSON) を読み、
// `codex_prompt` イベントとして Memoria の /api/activity/event に POST する。
//
// 設計方針 (claude-code-prompt.mjs と同一):
//   - **絶対にプロンプト処理を妨げない**。 ネットワーク失敗 / parse 失敗 / JSON
//     不正は全部握りつぶして exit 0。 stdout も汚さない。
//   - 1 秒タイムアウト。 Memoria が落ちてれば即諦める。
//   - prompt 先頭 240 文字だけ送る (個人情報の漏洩面を最小化)。
//
// ~/.codex/hooks.json 設定例 (UserPromptSubmit に concordia-hook と並べる):
//   "UserPromptSubmit": [{
//     "hooks": [
//       { "type": "command", "command": "node .../Concordia/tools/concordia-hook.mjs prompt" },
//       { "type": "command", "command": "node .../Memoria/server/hooks/codex-prompt.mjs" }
//     ]
//   }]
//
// 環境変数:
//   MEMORIA_URL — base URL (default http://localhost:5180)

const MEMORIA_URL = process.env.MEMORIA_URL || 'http://localhost:5180';
const TIMEOUT_MS = 1000;
const CONTENT_MAX = 240;

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', async () => {
  try {
    const payload = JSON.parse(buf || '{}');
    // Codex の hook payload は user prompt を `prompt` に入れる。 将来差異に備え
    // `user_prompt` もフォールバックで見る。
    const prompt =
      typeof payload.prompt === 'string' ? payload.prompt
      : typeof payload.user_prompt === 'string' ? payload.user_prompt
      : '';
    const sessionId = payload.session_id || payload.sid || null;
    const body = {
      kind: 'codex_prompt',
      ref_id: sessionId ? `${sessionId}:${Date.now()}` : null,
      source: payload.cwd || null,
      content: prompt.slice(0, CONTENT_MAX),
      occurred_at: new Date().toISOString(),
      metadata: {
        cwd: payload.cwd || null,
        session_id: sessionId,
        prompt_length: prompt.length,
      },
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      await fetch(`${MEMORIA_URL}/api/activity/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch {
      // ignore — server down / timeout
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // ignore — stdin not JSON / unreadable
  }
  // 必ず exit 0 (プロンプト処理を妨げない)
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
