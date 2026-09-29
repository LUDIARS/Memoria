import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { openDb } from '../db.js';
import { SESSION_LIST_LIMIT, usageDashboard } from './dashboard.js';
import { PRICE_TABLE_VERSION } from './price-table.js';
import { importSourceResponses, repriceStaleResponses } from './response-store.js';
import { ensureLlmUsageSchema } from './schema.js';
import { isSourceCurrent } from './source-store.js';
import { syncNativeUsage } from './sync.js';
import type { ParsedUsageSource, SourceSignature, UsageResponse } from './types.js';
import { parseUsagePeriod } from './usage-period.js';

type Db = ReturnType<typeof openDb>;
type Summary = Record<string, unknown>;
interface Dashboard {
  period: { summary: Summary; by_model: Summary[]; sessions_total: number; sessions_truncated: boolean };
  sessions: Array<{ session_id: string; subagents: number; responses: number }>;
}

const NOW_MS = Date.parse('2026-09-29T12:00:00+09:00');
const CUTOFF_MS = Date.parse('2026-09-01T00:00:00+09:00');

function withDb(run: (db: Db) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const db = openDb(':memory:');
    try {
      ensureLlmUsageSchema(db);
      await run(db);
    } finally {
      db.close();
    }
  };
}

function signature(path: string, provider: SourceSignature['provider'] = 'claude-code'): SourceSignature {
  return { path, provider, modifiedMs: 1, sizeBytes: 1 };
}

function response(overrides: Partial<UsageResponse>): UsageResponse {
  const occurredAt = overrides.occurredAt ?? '2026-09-25T00:00:00Z';
  return {
    provider: 'claude-code',
    responseId: 'msg',
    sessionId: 'session',
    agentId: null,
    familyId: overrides.sessionId ?? 'session',
    isOrigin: true,
    sourcePath: 'C:\\logs\\session.jsonl',
    occurredAt,
    occurredMs: Date.parse(occurredAt),
    usageDate: '2026-09-25',
    model: 'claude-opus-5-5',
    effort: 'medium',
    repoPath: 'C:\\workspace\\private-project',
    inputTokens: 1_000,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheWriteUnknownTokens: 0,
    outputTokens: 100,
    ...overrides,
  };
}

function importResponses(db: Db, path: string, responses: UsageResponse[]): void {
  const parsed: ParsedUsageSource = { provider: responses[0]?.provider ?? 'claude-code', sessionId: 'session', responses };
  importSourceResponses(db, signature(path, parsed.provider), parsed, '2026-09-29T00:00:00Z');
}

function dashboard(db: Db, from?: string, to?: string): Dashboard {
  return usageDashboard(db, parseUsagePeriod(from, to, NOW_MS), NOW_MS) as unknown as Dashboard;
}

async function tempDir(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'memoria-llm-store-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('copied history counts once and keeps the original attribution in either read order', withDb((db) => {
  const original = response({ responseId: 'msg_1', sessionId: 'main', familyId: 'main', sourcePath: 'main.jsonl' });
  const copy = response({
    responseId: 'msg_1', sessionId: 'main', familyId: 'main', isOrigin: false,
    sourcePath: 'resumed.jsonl', outputTokens: 100,
  });
  importResponses(db, 'resumed.jsonl', [copy]);
  importResponses(db, 'main.jsonl', [original]);
  const rows = db.prepare('SELECT source_path, is_origin, output_tokens FROM llm_usage_responses').all();
  assert.deepEqual(rows, [{ source_path: 'main.jsonl', is_origin: 1, output_tokens: 100 }]);

  importResponses(db, 'resumed.jsonl', [copy]);
  const again = db.prepare('SELECT source_path FROM llm_usage_responses').all();
  assert.deepEqual(again, [{ source_path: 'main.jsonl' }]);
}));

test('a later, larger stream snapshot replaces the stored usage without adding it', withDb((db) => {
  importResponses(db, 'a.jsonl', [response({ outputTokens: 10 })]);
  importResponses(db, 'a.jsonl', [response({ outputTokens: 250 })]);
  const summary = dashboard(db, '2026-09-25', '2026-09-25').period.summary;
  assert.equal(summary.responses, 1);
  assert.equal(summary.output_tokens, 250);
  assert.equal(summary.input_tokens, 1_000);
}));

test('subagent usage rolls up into the parent family', withDb((db) => {
  importResponses(db, 'parent.jsonl', [response({ responseId: 'p', sessionId: 'parent', familyId: 'parent' })]);
  importResponses(db, 'agent-a.jsonl', [
    response({ responseId: 'c1', sessionId: 'parent', familyId: 'parent', agentId: 'a' }),
    response({ responseId: 'c2', sessionId: 'parent', familyId: 'parent', agentId: 'b' }),
  ]);
  const view = dashboard(db, '2026-09-25', '2026-09-25');
  assert.equal(view.sessions.length, 1);
  assert.equal(view.sessions[0].session_id, 'parent');
  assert.equal(view.sessions[0].subagents, 2);
  assert.equal(view.sessions[0].responses, 3);
}));

test('unpriced models are shown as unevaluated, not as $0', withDb((db) => {
  importResponses(db, 'a.jsonl', [
    response({ responseId: 'priced', inputTokens: 1_000_000, outputTokens: 0 }),
    response({ responseId: 'unpriced', model: 'claude-opus-9', inputTokens: 500, outputTokens: 500 }),
  ]);
  const summary = dashboard(db, '2026-09-25', '2026-09-25').period.summary;
  assert.ok(Math.abs(Number(summary.cost_usd) - 4) < 1e-9);
  assert.equal(summary.unpriced_responses, 1);
  assert.equal(summary.unpriced_tokens, 1_000);
}));

test('period totals split input, cache and output cost for reconciliation', withDb((db) => {
  importResponses(db, 'a.jsonl', [response({
    inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWrite5mTokens: 1_000_000,
    cacheWrite1hTokens: 1_000_000, cacheWriteUnknownTokens: 0, outputTokens: 1_000_000,
  })]);
  const [model] = dashboard(db, '2026-09-25', '2026-09-25').period.by_model;
  assert.equal(model.model, 'claude-opus-5-5');
  const cost = [model.cost_input_usd, model.cost_cache_read_usd, model.cost_cache_write_usd, model.cost_output_usd]
    .map((value) => Number(Number(value).toFixed(6)));
  assert.deepEqual(cost, [4, 0.2, 13, 20]);
  assert.ok(Math.abs(Number(model.cost_usd) - 37.2) < 1e-9);
}));

test('period boundaries use JST calendar days', withDb((db) => {
  importResponses(db, 'a.jsonl', [
    response({ responseId: 'before', occurredAt: '2026-09-21T14:59:59Z', usageDate: '2026-09-21' }),
    response({ responseId: 'first', occurredAt: '2026-09-21T15:00:00Z', usageDate: '2026-09-22' }),
    response({ responseId: 'last', occurredAt: '2026-09-28T14:59:59Z', usageDate: '2026-09-28' }),
    response({ responseId: 'after', occurredAt: '2026-09-28T15:00:00Z', usageDate: '2026-09-29' }),
  ]);
  // 2026-09-22 00:00 JST up to 2026-09-29 00:00 JST.
  assert.equal(dashboard(db, '2026-09-22', '2026-09-28').period.summary.responses, 2);
}));

test('period totals include every family even beyond the session list limit', withDb((db) => {
  const count = SESSION_LIST_LIMIT + 1;
  importResponses(db, 'many.jsonl', Array.from({ length: count }, (_, index) => response({
    responseId: `msg_${index}`, sessionId: `s${index}`, familyId: `s${index}`,
  })));
  const view = dashboard(db, '2026-09-25', '2026-09-25');
  assert.equal(view.sessions.length, SESSION_LIST_LIMIT);
  assert.equal(view.period.sessions_total, count);
  assert.equal(view.period.sessions_truncated, true);
  assert.equal(view.period.summary.responses, count);
}));

test('a rate table version change re-prices stored responses without re-reading logs', withDb((db) => {
  importResponses(db, 'a.jsonl', [response({ inputTokens: 1_000_000, outputTokens: 0 })]);
  db.prepare("UPDATE llm_usage_responses SET cost_usd = 5, price_version = 'old'").run();
  assert.equal(repriceStaleResponses(db), 1);
  const row = db.prepare('SELECT cost_usd, price_version FROM llm_usage_responses').get() as {
    cost_usd: number; price_version: string;
  };
  assert.ok(Math.abs(row.cost_usd - 4) < 1e-9);
  assert.equal(row.price_version, PRICE_TABLE_VERSION);
  assert.equal(repriceStaleResponses(db), 0);
}));

test('sources imported by an older parser are re-read', withDb((db) => {
  const source = signature('a.jsonl');
  importResponses(db, 'a.jsonl', [response({})]);
  assert.equal(isSourceCurrent(db, source), true);
  db.prepare('UPDATE llm_usage_sources SET parser_version = 0').run();
  assert.equal(isSourceCurrent(db, source), false);
}));

test('archived Codex rollouts are discovered and deduplicated, and re-running sync adds nothing', async (context) => {
  const directory = await tempDir(context);
  const sessions = join(directory, 'sessions', '2026', '09', '25');
  const archived = join(directory, 'archived_sessions');
  await mkdir(sessions, { recursive: true });
  await mkdir(archived, { recursive: true });
  const rollout = [
    { type: 'session_meta', payload: { id: 'codex-1' } },
    { type: 'turn_context', timestamp: '2026-09-25T00:00:00Z', payload: { model: 'gpt-6-sol', effort: 'high' } },
    {
      type: 'event_msg', timestamp: '2026-09-25T00:00:01Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1_000, cached_input_tokens: 200, output_tokens: 50 } } },
    },
  ].map((row) => JSON.stringify(row)).join('\n');
  const onlyArchived = rollout.replace('codex-1', 'codex-2');
  await writeFile(join(sessions, 'rollout-1.jsonl'), rollout, 'utf8');
  await writeFile(join(archived, 'rollout-1.jsonl'), rollout, 'utf8');
  await writeFile(join(archived, 'rollout-2.jsonl'), onlyArchived, 'utf8');
  const roots = [
    { path: join(directory, 'sessions'), provider: 'codex-cli' as const },
    { path: archived, provider: 'codex-cli' as const },
  ];
  await withDb(async (db) => {
    const first = await syncNativeUsage(db, CUTOFF_MS, roots);
    assert.equal(first.scannedSources, 3);
    assert.equal(first.failedSources, 0);
    const second = await syncNativeUsage(db, CUTOFF_MS, roots);
    assert.equal(second.unchangedSources, 3);
    const summary = dashboard(db, '2026-09-25', '2026-09-25').period.summary;
    assert.equal(summary.responses, 2);
    assert.equal(summary.input_tokens, 1_600);
    assert.equal(summary.cache_read_tokens, 400);
    assert.equal(summary.output_tokens, 100);
    assert.ok(Math.abs(Number(summary.codex_credits) - 2 * (800 * 50 + 200 * 5 + 50 * 250) / 1_000_000) < 1e-12);
  })();
});
