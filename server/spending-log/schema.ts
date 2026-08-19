import type BetterSqlite3 from 'better-sqlite3';
import { LLM_RELAY_SCOPES } from './relay-policy.js';

type Db = BetterSqlite3.Database;

const RELAY_SCOPE_CHECK = LLM_RELAY_SCOPES.map((scope) => `'${scope}'`).join(', ');

const SPENDING_LOG_COLUMNS = [
  'id', 'privacy_class', 'retention_scope', 'llm_relay_scope', 'source_service', 'source_kind',
  'occurred_on', 'occurred_at', 'amount', 'currency',
  'place_name', 'google_place_id', 'google_maps_url', 'latitude', 'longitude', 'accuracy_m',
  'payment_json', 'items_json', 'purchase_category',
  'expense_planned', 'expense_rate', 'expense_rule_id',
  'source_refs_json', 'source_updated_at', 'synced_at',
].join(', ');

function spendingLogTableDdl(tableName: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id                    TEXT PRIMARY KEY,
      privacy_class         TEXT NOT NULL
                            CHECK (privacy_class = 'sensitive.financial_location'),
      retention_scope       TEXT NOT NULL
                            CHECK (retention_scope = 'local_only'),
      llm_relay_scope       TEXT NOT NULL
                            CHECK (llm_relay_scope IN (${RELAY_SCOPE_CHECK})),
      source_service        TEXT NOT NULL
                            CHECK (source_service = 'quaestor'),
      source_kind           TEXT NOT NULL
                            CHECK (source_kind IN ('transaction', 'receipt')),
      occurred_on           TEXT NOT NULL,
      occurred_at           TEXT,
      amount                INTEGER NOT NULL CHECK (amount > 0),
      currency              TEXT NOT NULL,
      place_name            TEXT,
      google_place_id       TEXT,
      google_maps_url       TEXT,
      latitude              REAL,
      longitude             REAL,
      accuracy_m            REAL,
      payment_json          TEXT NOT NULL,
      items_json            TEXT NOT NULL,
      purchase_category     TEXT NOT NULL
                            CHECK (purchase_category IN ('food', 'clothing', 'toy', 'undetermined')),
      expense_planned       INTEGER CHECK (expense_planned IN (0, 1)),
      expense_rate          REAL CHECK (expense_rate >= 0 AND expense_rate <= 1),
      expense_rule_id       INTEGER,
      source_refs_json      TEXT NOT NULL,
      source_updated_at     TEXT NOT NULL,
      synced_at             TEXT NOT NULL
    );
  `;
}

export function ensureSpendingLogSchema(db: Db): void {
  db.exec(spendingLogTableDdl('sensitive_spending_logs'));
  migrateRelayScopeCheck(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sensitive_spending_logs_date
      ON sensitive_spending_logs(occurred_on, currency);
    CREATE INDEX IF NOT EXISTS idx_sensitive_spending_logs_place
      ON sensitive_spending_logs(place_name, occurred_on);

    -- 生成済みの助言。 本文は LLM 出力そのものなので、 元データと同じ local_only 扱い。
    CREATE TABLE IF NOT EXISTS spending_advice_reports (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      date_from         TEXT NOT NULL,
      date_to           TEXT NOT NULL,
      currency          TEXT NOT NULL,
      provider_label    TEXT NOT NULL,
      model             TEXT NOT NULL,
      analytics_json    TEXT NOT NULL,
      advice_markdown   TEXT NOT NULL,
      record_count      INTEGER NOT NULL,
      generated_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_spending_advice_reports_range
      ON spending_advice_reports(date_to DESC, date_from DESC);
  `);
}

/**
 * 旧スキーマは llm_relay_scope を 'diary_only' 固定の CHECK で作っていた。 SQLite は
 * CHECK 制約を ALTER できないので、 旧定義が残っている場合だけテーブルを作り直す。
 * 既存行の値は移送するだけで書き換えない (昇格は本人同意の適用時に行う)。
 */
function migrateRelayScopeCheck(db: Db): void {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sensitive_spending_logs'`,
  ).get() as { sql: string } | undefined;
  if (!row) return;
  if (row.sql.includes(`llm_relay_scope IN (${RELAY_SCOPE_CHECK})`)) return;

  db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS sensitive_spending_logs_migrate`);
    db.exec(spendingLogTableDdl('sensitive_spending_logs_migrate'));
    db.exec(`
      INSERT INTO sensitive_spending_logs_migrate (${SPENDING_LOG_COLUMNS})
      SELECT ${SPENDING_LOG_COLUMNS} FROM sensitive_spending_logs
    `);
    db.exec(`DROP TABLE sensitive_spending_logs`);
    db.exec(`ALTER TABLE sensitive_spending_logs_migrate RENAME TO sensitive_spending_logs`);
  })();
}
