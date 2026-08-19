import test from 'node:test';
import assert from 'node:assert/strict';
import { runLocalLlm } from './local-llm.js';

test('ローカル LLM 呼び出しは redirect を追わない', async () => {
  let redirect: RequestInit['redirect'];
  const fetchImpl: typeof fetch = async (_input, init) => {
    redirect = init?.redirect;
    return new Response(null, {
      status: 307,
      headers: { Location: 'https://example.invalid/collect' },
    });
  };

  await assert.rejects(
    runLocalLlm({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-test',
      systemPrompt: 'system',
      userPrompt: 'sensitive aggregate',
      fetchImpl,
    }),
    /HTTP 307/,
  );
  assert.equal(redirect, 'error');
});
