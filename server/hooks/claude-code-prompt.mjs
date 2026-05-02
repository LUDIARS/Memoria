#!/usr/bin/env node
// Claude Code UserPromptSubmit hook → Memoria activity event.
//
// stdin から hook payload (session_id / prompt / cwd ... の JSON) を読み、
// `claude_code_prompt` イベントとして Memoria の /api/activity/event に POST する。
//
// 設計方針:
//   - **絶対にプロンプト処理を妨げない**。 ネットワーク失敗 / parse 失敗 / JSON
//     不正は全部握りつぶして exit 0。 stdout も汚さない。
//   - 1 秒タイムアウト。 Memoria が落ちてれば即諦める。
//   - prompt 先頭 240 文字だけ送る (個人情報の漏洩面を最小化)。
//
// settings.json 設定例:
//   "UserPromptSubmit": [{
//     "hooks": [{
//       "type": "command",
//       "command": "node \"<path>/server/hooks/claude-code-prompt.mjs\"",
//       "async": true,
//       "timeout": 2
//     }]
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
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    const body = {
      kind: 'claude_code_prompt',
      ref_id: payload.session_id ? `${payload.session_id}:${Date.now()}` : null,
      source: payload.cwd || null,
      content: prompt.slice(0, CONTENT_MAX),
      occurred_at: new Date().toISOString(),
      metadata: {
        cwd: payload.cwd || null,
        session_id: payload.session_id || null,
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
