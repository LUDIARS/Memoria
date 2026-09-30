import assert from 'node:assert/strict';
import test from 'node:test';
import repriceContract from '../../augur/contracts/reprice.contract.js';
import { openDb } from '../db.js';
import { PRICE_TABLE_VERSION } from './price-table.js';
import { importSourceResponses, repriceStaleResponses } from './response-store.js';
import { ensureLlmUsageSchema } from './schema.js';
import type { UsageResponse } from './types.js';

type Db = ReturnType<typeof openDb>;

// C-4 must reject stored rows from any other rate table. The earlier predicate
// only required a single distinct version, so an all-stale table passed.

function withDb(run: (db: Db) => void): () => void {
  return () => {
    const db = openDb(':memory:');
    try {
      ensureLlmUsageSchema(db);
      run(db);
    } finally {
      db.close();
    }
  };
}

function seed(db: Db, ids: string[]): void {
  const responses: UsageResponse[] = ids.map((responseId) => ({
    provider: 'claude-code', responseId, sessionId: 'session', agentId: null, familyId: 'session', isOrigin: true,
    sourcePath: 'a.jsonl', occurredAt: '2026-09-25T00:00:00Z', occurredMs: Date.parse('2026-09-25T00:00:00Z'),
    usageDate: '2026-09-25', model: 'claude-opus-5-5', effort: 'medium', repoPath: null,
    inputTokens: 1_000, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
    cacheWriteUnknownTokens: 0, outputTokens: 100,
  }));
  importSourceResponses(
    db, { path: 'a.jsonl', provider: 'claude-code', modifiedMs: 1, sizeBytes: 1 },
    { provider: 'claude-code', sessionId: 'session', responses }, '2026-09-29T00:00:00Z',
  );
}

test('C-4 rejects a table where every row shares an old price version', withDb((db) => {
  seed(db, ['a', 'b']);
  db.prepare("UPDATE llm_usage_responses SET price_version = 'old'").run();
  assert.equal(typeof repriceContract.post(0, db), 'string');
}));

test('C-4 rejects a table that still mixes old and current versions', withDb((db) => {
  seed(db, ['a', 'b']);
  db.prepare("UPDATE llm_usage_responses SET price_version = 'old' WHERE response_id = 'a'").run();
  assert.equal(typeof repriceContract.post(0, db), 'string');
}));

test('C-4 rejects a non-integer or negative re-priced count', withDb((db) => {
  seed(db, ['a']);
  assert.equal(typeof repriceContract.post(-1, db), 'string');
  assert.equal(typeof repriceContract.post(0.5, db), 'string');
}));

test('C-4 accepts the table after repriceStaleResponses', withDb((db) => {
  seed(db, ['a', 'b']);
  db.prepare("UPDATE llm_usage_responses SET price_version = 'old'").run();
  const repriced = repriceStaleResponses(db);
  assert.equal(repriced, 2);
  assert.equal(repriceContract.post(repriced, db), true);
  const versions = db.prepare('SELECT DISTINCT price_version AS v FROM llm_usage_responses').all() as Array<{ v: string }>;
  assert.deepEqual(versions.map((row) => row.v), [PRICE_TABLE_VERSION]);
}));
