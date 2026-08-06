import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export function ensureLlmUsageSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_usage_sources (
      source_path TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      session_id TEXT,
      modified_ms REAL NOT NULL,
      size_bytes INTEGER NOT NULL,
      imported_at TEXT NOT NULL,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS llm_usage_records (
      source_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      model TEXT NOT NULL,
      effort TEXT NOT NULL,
      repo_path TEXT,
      started_at TEXT,
      ended_at TEXT,
      context_count INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      cached_input_tokens INTEGER NOT NULL,
      cache_write_5m_tokens INTEGER NOT NULL,
      cache_write_1h_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      cost_basis TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      PRIMARY KEY (source_path, usage_date, model, effort),
      FOREIGN KEY (source_path) REFERENCES llm_usage_sources(source_path) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_llm_usage_records_date
      ON llm_usage_records(usage_date DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_records_session
      ON llm_usage_records(provider, session_id);

    CREATE TABLE IF NOT EXISTS llm_inventory_snapshots (
      snapshot_date TEXT PRIMARY KEY,
      captured_at TEXT NOT NULL,
      skill_count INTEGER NOT NULL,
      memory_count INTEGER NOT NULL,
      genius_card_count INTEGER,
      judgment_log_count INTEGER NOT NULL,
      local_llms_json TEXT NOT NULL,
      source_errors_json TEXT NOT NULL
    );
  `);
}
