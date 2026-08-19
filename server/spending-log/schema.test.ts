import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { ensureSpendingLogSchema } from './schema.js';

test('旧 relay scope 制約を既存行を保ったまま移行する', () => {
  const db = openDb(':memory:');
  try {
    db.exec(`
      CREATE TABLE sensitive_spending_logs (
        id TEXT PRIMARY KEY,
        privacy_class TEXT NOT NULL CHECK (privacy_class = 'sensitive.financial_location'),
        retention_scope TEXT NOT NULL CHECK (retention_scope = 'local_only'),
        llm_relay_scope TEXT NOT NULL CHECK (llm_relay_scope = 'diary_only'),
        source_service TEXT NOT NULL CHECK (source_service = 'quaestor'),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('transaction', 'receipt')),
        occurred_on TEXT NOT NULL,
        occurred_at TEXT,
        amount INTEGER NOT NULL CHECK (amount > 0),
        currency TEXT NOT NULL,
        place_name TEXT,
        google_place_id TEXT,
        google_maps_url TEXT,
        latitude REAL,
        longitude REAL,
        accuracy_m REAL,
        payment_json TEXT NOT NULL,
        items_json TEXT NOT NULL,
        purchase_category TEXT NOT NULL,
        expense_planned INTEGER,
        expense_rate REAL,
        expense_rule_id INTEGER,
        source_refs_json TEXT NOT NULL,
        source_updated_at TEXT NOT NULL,
        synced_at TEXT NOT NULL
      );
      INSERT INTO sensitive_spending_logs (
        id, privacy_class, retention_scope, llm_relay_scope, source_service, source_kind,
        occurred_on, amount, currency, payment_json, items_json, purchase_category,
        source_refs_json, source_updated_at, synced_at
      ) VALUES (
        'existing', 'sensitive.financial_location', 'local_only', 'diary_only', 'quaestor', 'receipt',
        '2026-07-20', 100, 'JPY', '{}', '[]', 'food', '{}',
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:01:00.000Z'
      );
    `);

    ensureSpendingLogSchema(db);

    const row = db.prepare(`
      SELECT id, llm_relay_scope FROM sensitive_spending_logs WHERE id = 'existing'
    `).get() as { id: string; llm_relay_scope: string };
    assert.deepEqual(row, { id: 'existing', llm_relay_scope: 'diary_only' });
    assert.doesNotThrow(() => {
      db.prepare(`UPDATE sensitive_spending_logs SET llm_relay_scope = ? WHERE id = ?`)
        .run('diary_and_spending_advice', 'existing');
    });
  } finally {
    db.close();
  }
});
