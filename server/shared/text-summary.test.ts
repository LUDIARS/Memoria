import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { textSummaryArgs, textSummaryEnvironment, runTextSummary, withSummaryBudget } from './text-summary.js';
import type { TextSummaryOptions, TextSummaryDependencies } from './text-summary.js';

let clock = Date.now() + 60_001;
function freshTime(): number { clock += 60_001; return clock; }
function options(provider = 'openai'): TextSummaryOptions {
  return { provider, model: 'fake-model', bin: 'never-run', baseUrl: 'https://summary.invalid', prompt: 'untrusted text', timeoutMs: 1000 };
}
function dependencies(): TextSummaryDependencies {
  const now = freshTime();
  return { environment: { MEMORIA_SUMMARY_API_KEY: 'dummy-summary-key' }, now: () => now };
}

test('要約の tools/MCP/hooks を停止し、親の権限・秘密・作業ディレクトリを引き継がない', () => {
  const args = textSummaryArgs('fake-model');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.ok(args.includes('{"disableAllHooks":true}'));
  const env = textSummaryEnvironment({ MEMORIA_SUMMARY_CLAUDE_TOKEN: 'fake-summary', HOME: '/privileged',
    MEMORIA_ADMIN_TOKEN: 'fake-admin', CONCORDIA_SESSION_ID: 'fake-session', NODE_OPTIONS: '--require evil',
    ANTHROPIC_API_KEY: 'fake-parent', PATH: '/runtime' }, '/isolated');
  assert.equal(env.HOME, '/isolated');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/isolated');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'fake-summary');
  assert.equal(env.MEMORIA_ADMIN_TOKEN, undefined);
  assert.equal(env.CONCORDIA_SESSION_ID, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.throws(() => textSummaryEnvironment({}, '/isolated'), /required/);
});

test('未対応 CLI は起動せず失敗し、大きすぎる要約入力を拒否する', async () => {
  await assert.rejects(runTextSummary({ provider: 'codex', model: 'fake', bin: 'never-run', baseUrl: '',
    prompt: 'untrusted', timeoutMs: 1 }), /unsupported/);
  await assert.rejects(withSummaryBudget('x'.repeat(40_001), async () => 'never'), /input exceeds/);
});

test('API request is tool-less, forbids redirects and rejects tool-call output', async () => {
  const deps = dependencies();
  let calls = 0;
  deps.fetch = async (_url, init) => {
    calls += 1;
    assert.equal(init?.redirect, 'error');
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.messages, [{ role: 'user', content: 'untrusted text' }]);
    assert.equal(request.tools, undefined);
    assert.equal(request.max_tokens, 4096);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'do not execute', tool_calls: [{ name: 'shell' }] } }] }));
  };
  await assert.rejects(runTextSummary(options(), deps), /forbidden tool calls/);
  deps.fetch = async (_url, init) => {
    calls += 1; assert.equal(init?.redirect, 'error');
    throw new Error('redirect rejected');
  };
  await assert.rejects(runTextSummary(options(), deps), /redirect rejected/);
  assert.equal(calls, 2);
});

test('API output is byte bounded and timeout aborts an outstanding request', async () => {
  const deps = dependencies();
  let cancelled = false;
  deps.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(runTextSummary(options(), deps), /response too large/);
  assert.equal(cancelled, true);
  let aborted = false;
  deps.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('test timeout')); }, { once: true });
  });
  await assert.rejects(runTextSummary({ ...options(), timeoutMs: 5 }, deps), /test timeout/);
  assert.equal(aborted, true);
});

test('fake CLI sees isolated cwd/env/tools and its directory is removed after success and failure', async () => {
  const now = freshTime();
  for (const fail of [false, true]) {
    let directory = '';
    const run = runTextSummary({ ...options('claude'), timeoutMs: 999_999 }, {
      now: () => now,
      environment: { PATH: '/fake-runtime', MEMORIA_SUMMARY_CLAUDE_TOKEN: 'dummy-summary', MEMORIA_ADMIN_TOKEN: 'dummy-admin' },
      runCli: async input => {
        directory = input.cwd ?? '';
        assert.notEqual(directory, process.cwd());
        await access(directory);
        assert.equal(input.env.HOME, directory);
        assert.equal(input.env.CLAUDE_CONFIG_DIR, directory);
        assert.equal(input.env.MEMORIA_ADMIN_TOKEN, undefined);
        assert.equal(input.env.CLAUDE_CODE_OAUTH_TOKEN, 'dummy-summary');
        assert.equal(input.args[input.args.indexOf('--tools') + 1], '');
        assert.equal(input.maxOutputBytes, 1024 * 1024);
        assert.equal(input.timeoutMs, 180_000);
        if (fail) throw new Error('fake runner failed');
        return 'plain summary';
      },
    });
    if (fail) await assert.rejects(run, /fake runner failed/);
    else assert.equal(await run, 'plain summary');
    assert.ok(directory);
    await assert.rejects(access(directory), { code: 'ENOENT' });
  }
});

test('concurrency and rate budgets reject before invoking work and release failed slots', async () => {
  const now = freshTime();
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const first = withSummaryBudget('a', () => new Promise<void>(resolve => { releaseFirst = resolve; }), now);
  const second = withSummaryBudget('b', () => new Promise<void>(resolve => { releaseSecond = resolve; }), now);
  let executed = false;
  await assert.rejects(withSummaryBudget('c', async () => { executed = true; }, now), /budget exhausted/);
  assert.equal(executed, false);
  releaseFirst(); releaseSecond(); await Promise.all([first, second]);
  await assert.rejects(withSummaryBudget('failure', async () => { throw new Error('fake work failure'); }, now), /fake work failure/);
  assert.equal(await withSummaryBudget('released', async () => 'ok', now), 'ok');
  const rateTime = freshTime();
  for (let count = 0; count < 10; count += 1) await withSummaryBudget('rate', async () => 'ok', rateTime);
  await assert.rejects(withSummaryBudget('exhausted', async () => { executed = true; }, rateTime), /budget exhausted/);
  assert.equal(executed, false);
  assert.equal(await withSummaryBudget('reset', async () => 'ok', rateTime + 60_000), 'ok');
});
