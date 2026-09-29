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

    -- One row per provider response. Replaces llm_usage_records as the source of
    -- the dashboard; the legacy aggregate table is kept untouched, never dropped.
    CREATE TABLE IF NOT EXISTS llm_usage_responses (
      provider TEXT NOT NULL,
      response_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      family_id TEXT NOT NULL,
      is_origin INTEGER NOT NULL,
      source_path TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      occurred_ms INTEGER NOT NULL,
      usage_date TEXT NOT NULL,
      model TEXT NOT NULL,
      effort TEXT NOT NULL,
      repo_path TEXT,
      input_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_5m_tokens INTEGER NOT NULL,
      cache_write_1h_tokens INTEGER NOT NULL,
      cache_write_unknown_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL,
      cost_input_usd REAL,
      cost_cache_read_usd REAL,
      cost_cache_write_usd REAL,
      cost_output_usd REAL,
      cost_basis TEXT NOT NULL,
      codex_credits REAL,
      price_version TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      PRIMARY KEY (provider, response_id)
    );

    CREATE INDEX IF NOT EXISTS idx_llm_usage_responses_date
      ON llm_usage_responses(usage_date);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_responses_session
      ON llm_usage_responses(provider, session_id);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_responses_price
      ON llm_usage_responses(price_version);

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
  const sourceColumns = (db.prepare('PRAGMA table_info(llm_usage_sources)').all() as Array<{ name: string }>)
    .map((column) => column.name);
  if (!sourceColumns.includes('parser_version')) {
    // Existing rows default to 0 so every source is re-read once by the current parser.
    db.exec('ALTER TABLE llm_usage_sources ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 0');
  }
}
