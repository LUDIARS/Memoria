import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { openDb } from '../db.js';
import { externalSourceError, isMemoryFilePath } from './inventory.js';
import { parseNativeLog } from './native-log-reader.js';
import { estimateEquivalentApiCost } from './price-table.js';
import { makeLlmUsageRouter } from './router.js';
import { ensureLlmUsageSchema } from './schema.js';
import { isSourceCurrent, replaceSourceUsage, usageDashboard } from './store.js';
import { importWindowStartMs } from './sync.js';
import type { ParsedUsageSource, SourceSignature, UsageRecord } from './types.js';

const CUTOFF_MS = Date.parse('2026-08-01T00:00:00+09:00');

test('supported Codex models have a nonzero equivalent API cost', () => {
  const usage = {
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 1_000_000,
  };
  assert.deepEqual(
    estimateEquivalentApiCost('codex-cli', '5.3-codex', usage),
    { usd: 11.25, basis: 'openai:gpt-5-codex' },
  );
  assert.deepEqual(
    estimateEquivalentApiCost('codex-cli', 'gpt-5-codex', usage),
    { usd: 11.25, basis: 'openai:gpt-5-codex' },
  );
});

test('memory inventory recognizes both provider directory names', () => {
  assert.equal(isMemoryFilePath('C:\\home\\.claude\\projects\\repo\\memory\\notes.md'), true);
  assert.equal(isMemoryFilePath('C:\\home\\.codex\\memories\\notes.md'), true);
  assert.equal(isMemoryFilePath('C:\\home\\.codex\\sessions\\notes.md'), false);
});

test('inventory errors never expose configured endpoint details', () => {
  const sensitiveError = new TypeError('Failed to parse configured endpoint with sensitive details');
  assert.equal(externalSourceError('Local LLM', sensitiveError), 'Local LLM unavailable');
  assert.equal(externalSourceError('Local LLM', null, 401), 'Local LLM unavailable (HTTP 401)');
});

test('native log parsers exclude rows before the configured import window', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'memoria-llm-usage-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const claudePath = join(directory, 'claude.jsonl');
  await writeFile(claudePath, [
    {
      timestamp: '2026-07-31T12:00:00Z', cwd: 'C:\\work\\old',
      message: { id: 'old', model: 'sonnet', usage: { input_tokens: 100, output_tokens: 10 } },
    },
    {
      timestamp: '2026-08-01T01:00:00Z', cwd: 'C:\\work\\current',
      message: { id: 'new', model: 'sonnet', usage: { input_tokens: 20, output_tokens: 5 } },
    },
  ].map((row) => JSON.stringify(row)).join('\n'), 'utf8');
  const claude = await parseNativeLog(signature(claudePath, 'claude-code'), CUTOFF_MS);
  assert.equal(claude.records.length, 1);
  assert.equal(claude.records[0].inputTokens, 20);
  assert.equal(claude.records[0].contexts, 1);

  const codexPath = join(directory, 'codex.jsonl');
  await writeFile(codexPath, [
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
  ].map((row) => JSON.stringify(row)).join('\n'), 'utf8');
  const codex = await parseNativeLog(signature(codexPath, 'codex-cli'), CUTOFF_MS);
  assert.equal(codex.records.length, 1);
  assert.equal(codex.records[0].inputTokens, 40);
  assert.equal(codex.records[0].cachedInputTokens, 10);
  assert.equal(codex.records[0].outputTokens, 10);
  assert.equal(codex.records[0].contexts, 1);
});

test('source refresh preserves aged-out aggregates and dashboard hides absolute paths', () => {
  const db = openDb(':memory:');
  try {
    ensureLlmUsageSchema(db);
    const source = signature('C:\\logs\\session.jsonl', 'codex-cli');
    replaceSourceUsage(db, source, parsed([
      record('2026-07-31', 'C:\\workspace\\private-project'),
      record('2026-08-01', 'C:\\workspace\\private-project'),
    ]), '2026-07-31');
    const changedSource = { ...source, modifiedMs: 2, sizeBytes: 2 };
    assert.equal(isSourceCurrent(db, changedSource), false);
    replaceSourceUsage(db, changedSource, parsed([
      record('2026-08-02', 'C:\\workspace\\private-project'),
    ]), '2026-08-01');
    assert.equal(isSourceCurrent(db, changedSource), true);

    const dates = db.prepare(
      'SELECT usage_date FROM llm_usage_records ORDER BY usage_date',
    ).all() as Array<{ usage_date: string }>;
    assert.deepEqual(dates.map((row) => row.usage_date), ['2026-07-31', '2026-08-02']);

    const dashboard = usageDashboard(db) as { sessions: Array<{ repo_name: string }> };
    assert.equal(dashboard.sessions[0].repo_name, 'private-project');
  } finally {
    db.close();
  }
});

test('dashboard strips saved Local LLM endpoints from historical snapshots', () => {
  const db = openDb(':memory:');
  try {
    ensureLlmUsageSchema(db);
    db.prepare(`
      INSERT INTO llm_inventory_snapshots (
        snapshot_date, captured_at, skill_count, memory_count, genius_card_count,
        judgment_log_count, local_llms_json, source_errors_json
      ) VALUES (?, ?, 0, 0, NULL, 0, ?, ?)
    `).run(
      '2026-08-06',
      '2026-08-06T00:00:00Z',
      JSON.stringify([{
        endpoint: 'http://redacted.invalid/v1',
        configuredModel: 'local-model',
        available: true,
        models: [{ id: 'local-model', ownedBy: 'private-owner' }],
      }]),
      JSON.stringify(['Local LLM unavailable: sensitive request details']),
    );
    const dashboard = usageDashboard(db) as {
      inventory: Array<{ local_llms: unknown }>;
    };
    assert.deepEqual(dashboard.inventory[0].local_llms, [{
      configuredModel: 'local-model',
      available: true,
      models: [{ id: 'local-model' }],
    }]);
    assert.equal(JSON.stringify(dashboard).includes('redacted.invalid'), false);
    assert.equal(JSON.stringify(dashboard).includes('sensitive request details'), false);
  } finally {
    db.close();
  }
});

test('LLM usage routes accept Access-forwarded browser requests without exposing direct remote access', async () => {
  const db = openDb(':memory:');
  try {
    const app = new Hono();
    app.route('/', makeLlmUsageRouter({ db }));

    const remote = await requestFrom(app, '192.0.2.1', 'http://localhost/api/llm-usage');
    assert.equal(remote.status, 403);
    const crossOrigin = await requestFrom(app, '127.0.0.1', 'http://localhost/api/llm-usage', {
      headers: { Origin: 'https://example.invalid' },
    });
    assert.equal(crossOrigin.status, 403);
    const access = await requestFrom(app, '127.0.0.1', 'http://memoria.ai-run-do.com/api/llm-usage', {
      headers: {
        Origin: 'https://memoria.ai-run-do.com',
        'X-Forwarded-Proto': 'https',
      },
    });
    assert.equal(access.status, 200);
    const local = await requestFrom(app, '127.0.0.1', 'http://localhost/api/llm-usage', {
      headers: { Origin: 'http://localhost' },
    });
    assert.equal(local.status, 200);
  } finally {
    db.close();
  }
});

test('import window starts at midnight JST and includes the requested calendar days', () => {
  const now = Date.parse('2026-08-06T13:34:00+09:00');
  assert.equal(
    new Date(importWindowStartMs(8, now)).toISOString(),
    '2026-07-29T15:00:00.000Z',
  );
});

function signature(path: string, provider: SourceSignature['provider']): SourceSignature {
  return { path, provider, modifiedMs: 1, sizeBytes: 1 };
}

function requestFrom(
  app: Hono,
  address: string,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(app.request(url, init, {
    incoming: {
      socket: {
        remoteAddress: address,
        remotePort: 12345,
        remoteFamily: address.includes(':') ? 'IPv6' : 'IPv4',
      },
    },
  }));
}

function parsed(records: UsageRecord[]): ParsedUsageSource {
  return { provider: 'codex-cli', sessionId: 'session', records };
}

function record(usageDate: string, repoPath: string): UsageRecord {
  return {
    sourcePath: 'C:\\logs\\session.jsonl',
    sessionId: 'session',
    provider: 'codex-cli',
    usageDate,
    model: '5.3-codex',
    effort: 'high',
    repoPath,
    startedAt: `${usageDate}T00:00:00Z`,
    endedAt: `${usageDate}T00:01:00Z`,
    contexts: 1,
    inputTokens: 10,
    cachedInputTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 1,
    totalTokens: 11,
    costUsd: 0.0000225,
    costBasis: 'openai:gpt-5-codex',
  };
}
