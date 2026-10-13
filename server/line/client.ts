// LINE Messaging API の push 送信。 https://developers.line.biz/ja/reference/messaging-api/#send-push-message
// LINE Notify は 2025-03-31 に終了しているので使わない。

const LINE_PUSH_API = 'https://api.line.me/v2/bot/message/push';
/** text message 1 件の上限文字数。 */
export const LINE_TEXT_LIMIT = 5000;
/** 1 リクエストで送れる message 数の上限。 */
const LINE_MESSAGES_PER_REQUEST = 5;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface LinePushResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

/** 長文を LINE の上限で区切る。 改行位置で切れるなら改行で切る。 */
export function splitLineText(text: string, limit: number = LINE_TEXT_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf('\n', limit);
    const at = cut > limit / 2 ? cut : limit;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  if (rest.length) parts.push(rest);
  return parts.slice(0, LINE_MESSAGES_PER_REQUEST);
}

export async function pushLineText(
  input: { token: string; to: string; text: string },
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<LinePushResult> {
  if (!input.token) return { ok: false, reason: 'LINE のチャネルアクセストークンが未設定です' };
  if (!input.to) return { ok: false, reason: 'LINE の送り先 ID が未設定です' };
  const messages = splitLineText(input.text).map((text) => ({ type: 'text', text }));
  if (!messages.length) return { ok: false, reason: '送る本文が空です' };
  const res = await fetchImpl(LINE_PUSH_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${input.token}`,
    },
    body: JSON.stringify({ to: input.to, messages }),
  });
  if (res.ok) return { ok: true, status: res.status };
  // 応答本文は LINE のエラー説明 (トークンは含まない)。 長さだけ抑える。
  const detail = (await res.text().catch(() => '')).slice(0, 300);
  return { ok: false, status: res.status, reason: `LINE が ${res.status} を返しました ${detail}`.trim() };
}
