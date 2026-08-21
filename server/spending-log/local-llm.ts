/**
 * 消費傾向助言だけが使う、 loopback 限定の LLM クライアント。
 *
 * 共通の runLlm() は使わない。 runLlm() は Concordia へプロンプト本文を転送し (llm-request)、
 * provider 未設定時に Claude CLI (クラウド) へフォールバックする。 どちらも
 * `sensitive.financial_location` を Memoria の外へ出すことになるため、 この経路は
 *
 *   - 送信先を loopback に限定 (入口で検証し、 満たさなければ即エラー)
 *   - フォールバック無し (設定が無ければ助言を出さずに失敗する)
 *   - プロンプト本文をどこにも転送・ログ出力しない
 *
 * を守る専用実装にしている。
 */

const REQUEST_TIMEOUT_MS = 180_000;
/** reasoning 系ローカルモデルは思考でトークンを使うので余裕を持たせる。 */
const MAX_TOKENS = 4096;

export interface LocalLlmRequest {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  fetchImpl?: typeof fetch;
}

export interface LocalLlmResult {
  text: string;
  model: string;
  provider_label: string;
}

export async function runLocalLlm(request: LocalLlmRequest): Promise<LocalLlmResult> {
  const base = parseLoopbackBaseUrl(request.baseUrl);
  if (!request.model.trim()) {
    throw new Error('ローカル LLM のモデル名が未設定です (spending_advice.local_llm_model)');
  }

  const fetchImpl = request.fetchImpl ?? fetch;
  const response = await fetchImpl(new URL('chat/completions', ensureTrailingSlash(base)), {
    method: 'POST',
    // fetch の既定は redirect を追う。 loopback が 307/308 を返した場合に機微な
    // POST 本文を外部ホストへ再送しないよう、 redirect は常にエラーにする。
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      model: request.model,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    // 本文にはプロンプトのエコーが含まれうるので status だけを外に出す。
    throw new Error(`ローカル LLM の呼び出しに失敗しました (HTTP ${response.status})`);
  }

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = payload.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) {
    throw new Error('ローカル LLM が空の応答を返しました');
  }
  return { text, model: request.model, provider_label: `ローカル LLM (${base.host})` };
}

/**
 * 設定保存時にも同じ制約で弾くための入口。 送信直前 (parseLoopbackBaseUrl) が最終防衛線で、
 * ここは「保存できたのに生成時だけ失敗する」状態を作らないための前段チェック。
 */
export function assertLoopbackBaseUrl(value: string): void {
  parseLoopbackBaseUrl(value);
}

function parseLoopbackBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('spending_advice.local_llm_base_url は絶対 URL である必要があります');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('spending_advice.local_llm_base_url は http / https のみ許可されます');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost'
    || hostname === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (!loopback) {
    throw new Error('消費傾向の助言はローカル LLM 限定です (loopback アドレスのみ許可)');
  }
  return url;
}

function ensureTrailingSlash(url: URL): URL {
  if (url.pathname.endsWith('/')) return url;
  return new URL(`${url.pathname}/`, url);
}
