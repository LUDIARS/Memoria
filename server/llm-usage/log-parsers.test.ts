import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parseNativeLog } from './native-log-reader.js';
import type { SourceSignature } from './types.js';

const CUTOFF_MS = Date.parse('2026-08-01T00:00:00+09:00');

async function tempDir(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'memoria-llm-parse-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n'), 'utf8');
}

function signature(path: string, provider: SourceSignature['provider']): SourceSignature {
  return { path, provider, modifiedMs: 1, sizeBytes: 1 };
}

function claudeRow(id: string, timestamp: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    timestamp,
    sessionId: 'main-session',
    cwd: 'C:\\work\\repo',
    ...extra,
    message: { id, model: 'claude-opus-5-5', usage, ...(extra.message as object | undefined) },
  };
}

test('native log parsers exclude rows before the configured import window', async (context) => {
  const directory = await tempDir(context);
  const claudePath = join(directory, 'main-session.jsonl');
  await writeJsonl(claudePath, [
    claudeRow('old', '2026-07-31T12:00:00Z', { input_tokens: 100, output_tokens: 10 }),
    claudeRow('new', '2026-08-01T01:00:00Z', { input_tokens: 20, output_tokens: 5 }),
  ]);
  const claude = await parseNativeLog(signature(claudePath, 'claude-code'), CUTOFF_MS);
  assert.deepEqual(claude.responses.map((r) => r.responseId), ['new']);

  const codexPath = join(directory, 'codex.jsonl');
  await writeJsonl(codexPath, [
    { type: 'session_meta', payload: { id: 'codex-session', cwd: 'C:\\work\\current' } },
    { type: 'turn_context', timestamp: '2026-07-31T12:00:00Z', payload: { model: '5.3-codex', effort: 'high' } },
    {
      type: 'event_msg', timestamp: '2026-07-31T12:01:00Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 } } },
    },
    { type: 'turn_context', timestamp: '2026-08-01T01:00:00Z', payload: { model: '5.3-codex', effort: 'high' } },
    {
      type: 'event_msg', timestamp: '2026-08-01T01:01:00Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 150, cached_input_tokens: 30, output_tokens: 20 } } },
    },
  ]);
  const codex = await parseNativeLog(signature(codexPath, 'codex-cli'), CUTOFF_MS);
  assert.equal(codex.responses.length, 1);
  assert.equal(codex.responses[0].inputTokens, 40);
  assert.equal(codex.responses[0].cacheReadTokens, 10);
  assert.equal(codex.responses[0].outputTokens, 10);
});

test('Claude stream fragments of one message keep the final usage once', async (context) => {
  const directory = await tempDir(context);
  const path = join(directory, 'main-session.jsonl');
  const prompt = { input_tokens: 7, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0 };
  await writeJsonl(path, [
    claudeRow('msg_1', '2026-08-02T00:00:00Z', { ...prompt, output_tokens: 3 }),
    claudeRow('msg_1', '2026-08-02T00:00:05Z', { ...prompt, output_tokens: 40 }),
    claudeRow('msg_1', '2026-08-02T00:00:09Z', { ...prompt, output_tokens: 250 }),
  ]);
  const parsed = await parseNativeLog(signature(path, 'claude-code'), CUTOFF_MS);
  assert.equal(parsed.responses.length, 1);
  const [response] = parsed.responses;
  assert.equal(response.outputTokens, 250);
  assert.equal(response.inputTokens, 7);
  assert.equal(response.cacheReadTokens, 1_000);
  assert.equal(response.occurredAt, '2026-08-02T00:00:00Z');
});

test('thinking is inside output_tokens and never added again', async (context) => {
  const directory = await tempDir(context);
  const claudePath = join(directory, 'main-session.jsonl');
  await writeJsonl(claudePath, [
    claudeRow('msg_t', '2026-08-02T00:00:00Z', { input_tokens: 1, output_tokens: 900 }, {
      message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'y' }] },
    }),
  ]);
  const claude = await parseNativeLog(signature(claudePath, 'claude-code'), CUTOFF_MS);
  assert.equal(claude.responses[0].outputTokens, 900);

  const codexPath = join(directory, 'codex.jsonl');
  await writeJsonl(codexPath, [
    { type: 'session_meta', payload: { id: 'codex-thinking' } },
    { type: 'turn_context', timestamp: '2026-08-02T00:00:00Z', payload: { model: 'gpt-6-sol', effort: 'high' } },
    {
      type: 'event_msg', timestamp: '2026-08-02T00:00:01Z',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 500, reasoning_output_tokens: 400 } },
      },
    },
  ]);
  const codex = await parseNativeLog(signature(codexPath, 'codex-cli'), CUTOFF_MS);
  assert.equal(codex.responses[0].outputTokens, 500);
});

test('cache write TTL breakdown is kept and unknown TTL stays separate', async (context) => {
  const directory = await tempDir(context);
  const path = join(directory, 'main-session.jsonl');
  await writeJsonl(path, [
    claudeRow('split', '2026-08-02T00:00:00Z', {
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
    }),
    claudeRow('legacy', '2026-08-02T00:01:00Z', { cache_creation_input_tokens: 50 }),
    claudeRow('partial', '2026-08-02T00:02:00Z', {
      cache_creation_input_tokens: 90,
      cache_creation: { ephemeral_1h_input_tokens: 60 },
    }),
  ]);
  const parsed = await parseNativeLog(signature(path, 'claude-code'), CUTOFF_MS);
  const byId = new Map(parsed.responses.map((r) => [r.responseId, r]));
  assert.deepEqual(
    ['split', 'legacy', 'partial'].map((id) => {
      const r = byId.get(id);
      return [r?.cacheWrite5mTokens, r?.cacheWrite1hTokens, r?.cacheWriteUnknownTokens];
    }),
    [[100, 200, 0], [0, 0, 50], [0, 60, 30]],
  );
});

test('subagent sidechains keep the parent session as family and their own agent id', async (context) => {
  const directory = await tempDir(context);
  const subagents = join(directory, 'parent-session', 'subagents');
  await mkdir(subagents, { recursive: true });
  const path = join(subagents, 'agent-abc.jsonl');
  await writeJsonl(path, [
    claudeRow('child_msg', '2026-08-02T00:00:00Z', { input_tokens: 5, output_tokens: 5 }, {
      sessionId: 'parent-session', isSidechain: true, agentId: 'abc',
    }),
  ]);
  const parsed = await parseNativeLog(signature(path, 'claude-code'), CUTOFF_MS);
  const [response] = parsed.responses;
  assert.equal(response.sessionId, 'parent-session');
  assert.equal(response.familyId, 'parent-session');
  assert.equal(response.agentId, 'abc');
  assert.equal(response.isOrigin, true);
});

test('history copied into another session file is marked as a copy', async (context) => {
  const directory = await tempDir(context);
  const path = join(directory, 'resumed-session.jsonl');
  await writeJsonl(path, [
    claudeRow('msg_copied', '2026-08-02T00:00:00Z', { input_tokens: 5, output_tokens: 5 }, { sessionId: 'main-session' }),
    claudeRow('msg_new', '2026-08-02T01:00:00Z', { input_tokens: 5, output_tokens: 5 }, { sessionId: 'resumed-session' }),
  ]);
  const parsed = await parseNativeLog(signature(path, 'claude-code'), CUTOFF_MS);
  const byId = new Map(parsed.responses.map((r) => [r.responseId, r]));
  assert.equal(byId.get('msg_copied')?.isOrigin, false);
  assert.equal(byId.get('msg_copied')?.sessionId, 'main-session');
  assert.equal(byId.get('msg_new')?.isOrigin, true);
});

test('effort is recorded per turn for Codex and per row override for Claude', async (context) => {
  const directory = await tempDir(context);
  const codexPath = join(directory, 'codex.jsonl');
  const count = (input: number, output: number, timestamp: string) => ({
    type: 'event_msg', timestamp,
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } } },
  });
  await writeJsonl(codexPath, [
    { type: 'session_meta', payload: { id: 'codex-effort' } },
    { type: 'turn_context', timestamp: '2026-08-02T00:00:00Z', payload: { model: 'gpt-6-sol', effort: 'medium' } },
    count(10, 1, '2026-08-02T00:00:01Z'),
    { type: 'turn_context', timestamp: '2026-08-02T00:01:00Z', payload: { model: 'gpt-6-sol', effort: 'xhigh' } },
    count(20, 2, '2026-08-02T00:01:01Z'),
  ]);
  const codex = await parseNativeLog(signature(codexPath, 'codex-cli'), CUTOFF_MS);
  assert.deepEqual(codex.responses.map((r) => r.effort), ['medium', 'xhigh']);

  const claudePath = join(directory, 'main-session.jsonl');
  await writeJsonl(claudePath, [
    { type: 'system', timestamp: '2026-08-02T00:00:00Z', effort: 'medium' },
    claudeRow('a', '2026-08-02T00:00:01Z', { output_tokens: 1 }),
    claudeRow('b', '2026-08-02T00:00:02Z', { output_tokens: 1 }, { perTurnEffort: 'max' }),
    claudeRow('c', '2026-08-02T00:00:03Z', { output_tokens: 1 }),
  ]);
  const claude = await parseNativeLog(signature(claudePath, 'claude-code'), CUTOFF_MS);
  assert.deepEqual(claude.responses.map((r) => r.effort), ['medium', 'max', 'medium']);
});

test('usage date follows the JST calendar at the midnight boundary', async (context) => {
  const directory = await tempDir(context);
  const path = join(directory, 'main-session.jsonl');
  await writeJsonl(path, [
    claudeRow('before', '2026-09-21T14:59:59.999Z', { output_tokens: 1 }),
    claudeRow('after', '2026-09-21T15:00:00.000Z', { output_tokens: 1 }),
  ]);
  const parsed = await parseNativeLog(signature(path, 'claude-code'), CUTOFF_MS);
  assert.deepEqual(parsed.responses.map((r) => r.usageDate), ['2026-09-21', '2026-09-22']);
});
