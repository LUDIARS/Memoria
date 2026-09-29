import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { openDb } from '../db.js';
import { externalSourceError, isMemoryFilePath } from './inventory.js';
import { makeLlmUsageRouter } from './router.js';
import { ensureLlmUsageSchema } from './schema.js';
import { usageDashboard } from './dashboard.js';
import { importWindowStartMs } from './sync-window.js';
import { parseUsagePeriod } from './usage-period.js';

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
    const dashboard = usageDashboard(db, parseUsagePeriod(undefined, undefined)) as {
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

test('LLM usage route rejects malformed periods instead of defaulting them', async () => {
  const db = openDb(':memory:');
  try {
    const app = new Hono();
    app.route('/', makeLlmUsageRouter({ db }));
    for (const query of ['from=2026-02-30', 'from=2026-09-29&to=2026-09-22', 'to=yesterday']) {
      const response = await requestFrom(app, '127.0.0.1', `http://localhost/api/llm-usage?${query}`);
      assert.equal(response.status, 400, query);
    }
    const valid = await requestFrom(app, '127.0.0.1', 'http://localhost/api/llm-usage?from=2026-09-22&to=2026-09-28');
    assert.equal(valid.status, 200);
    const body = await valid.json() as { period: { from: string; to: string } };
    assert.deepEqual([body.period.from, body.period.to], ['2026-09-22', '2026-09-28']);
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
