// Memoria → Concordia へ「CC への指示 / 応答」 を forward する.
//
// 主目的: Memoria が裏で claude / codex / gemini に投げているプロンプトと結果を
// Concordia の chat 経由でログに残し、 開発時に AI に「Memoria が何を考えて
// 何を投げたか」 を把握させる. ユーザ要望 (2026-05-23).
//
// best-effort + 非同期: Concordia が落ちていても Memoria 本機能には一切影響
// しないよう、 fire-and-forget + 短い timeout で握りつぶす.
//
// env で opt-in:
//   MEMORIA_CONCORDIA_FORWARD=1            forward を有効化 (既定: 無効)
//   MEMORIA_CONCORDIA_URL=http://127.0.0.1:17330   Concordia base URL
//   MEMORIA_CONCORDIA_CHANNEL=memoria-cc-instructions  chat channel 名

const DEFAULT_URL = 'http://127.0.0.1:17330';
const DEFAULT_CHANNEL = 'memoria-cc-instructions';
const FORWARD_TIMEOUT_MS = 2_000;
const TEXT_HEAD_LIMIT = 4_000;

function isEnabled(): boolean {
  return process.env.MEMORIA_CONCORDIA_FORWARD === '1';
}

function endpoint(): string {
  const base = (process.env.MEMORIA_CONCORDIA_URL || DEFAULT_URL).replace(/\/+$/, '');
  return `${base}/v1/chat`;
}

function channel(): string {
  return process.env.MEMORIA_CONCORDIA_CHANNEL || DEFAULT_CHANNEL;
}

function truncate(text: string): { head: string; suffix: string } {
  if (text.length <= TEXT_HEAD_LIMIT) return { head: text, suffix: '' };
  return {
    head: text.slice(0, TEXT_HEAD_LIMIT),
    suffix: ` …(+${text.length - TEXT_HEAD_LIMIT} chars)`,
  };
}

export type ConcordiaForwardKind = 'llm-request' | 'llm-response' | 'llm-error';

export interface ConcordiaForwardArgs {
  kind: ConcordiaForwardKind;
  task: string;       // LlmTaskName
  provider: string;   // 'claude' | 'gemini' | 'codex' | 'openai'
  text: string;       // prompt / result / error
  model?: string;
  durationMs?: number;
}

export function formatForwardText(args: ConcordiaForwardArgs): string {
  const { head, suffix } = truncate(args.text);
  const meta = [
    `task=${args.task}`,
    `provider=${args.provider}`,
    args.model ? `model=${args.model}` : null,
    args.durationMs !== undefined ? `duration=${args.durationMs}ms` : null,
  ].filter(Boolean).join(' ');
  return `[${args.kind}] ${meta}\n${head}${suffix}`;
}

/**
 * Concordia へ chat post を投げる. 失敗は握りつぶす (Memoria 本機能には影響させない).
 * 戻り値は「forward を試みたか」 (= enabled かつ fetch をキック)。 完了は待たない.
 */
export function forwardToConcordia(args: ConcordiaForwardArgs): boolean {
  if (!isEnabled()) return false;
  const body = JSON.stringify({
    channel: channel(),
    session_id: null,
    author_label: `Memoria / ${args.task}`,
    text: formatForwardText(args),
  });
  // fire-and-forget. 失敗ログは出さない (ノイズになる).
  void (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
      try {
        await fetch(endpoint(), {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // swallow
    }
  })();
  return true;
}
