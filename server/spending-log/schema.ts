import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export function ensureSpendingLogSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sensitive_spending_logs (
      id                    TEXT PRIMARY KEY,
      privacy_class         TEXT NOT NULL
                            CHECK (privacy_class = 'sensitive.financial_location'),
      retention_scope       TEXT NOT NULL
                            CHECK (retention_scope = 'local_only'),
      llm_relay_scope       TEXT NOT NULL
                            CHECK (llm_relay_scope = 'diary_only'),
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

    CREATE INDEX IF NOT EXISTS idx_sensitive_spending_logs_date
      ON sensitive_spending_logs(occurred_on, currency);
    CREATE INDEX IF NOT EXISTS idx_sensitive_spending_logs_place
      ON sensitive_spending_logs(place_name, occurred_on);
  `);
}
