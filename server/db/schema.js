import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      url               TEXT NOT NULL,
      title             TEXT NOT NULL,
      html_path         TEXT NOT NULL,
      summary           TEXT,
      memo              TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'pending',
      error             TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed_at  TEXT,
      access_count      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bookmark_categories (
      bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      category    TEXT NOT NULL,
      PRIMARY KEY (bookmark_id, category)
    );

    CREATE TABLE IF NOT EXISTS accesses (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      bookmark_id  INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      accessed_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dig_sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      query         TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      status        TEXT NOT NULL DEFAULT 'pending',
      error         TEXT,
      result_json   TEXT,
      preview_json  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_dig_sessions_created
      ON dig_sessions(created_at DESC);

    CREATE TABLE IF NOT EXISTS recommendation_dismissals (
      url           TEXT PRIMARY KEY,
      dismissed_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS page_visits (
      url            TEXT PRIMARY KEY,
      title          TEXT,
      first_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
      visit_count    INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_page_visits_last_seen
      ON page_visits(last_seen_at DESC);

    CREATE INDEX IF NOT EXISTS idx_bookmark_categories_category
      ON bookmark_categories(category);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_status
      ON bookmarks(status);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_url
      ON bookmarks(url);
    CREATE INDEX IF NOT EXISTS idx_accesses_bookmark
      ON accesses(bookmark_id, accessed_at DESC);

    CREATE TABLE IF NOT EXISTS page_metadata (
      url               TEXT PRIMARY KEY,
      title             TEXT,
      meta_description  TEXT,
      og_title          TEXT,
      og_description    TEXT,
      og_image          TEXT,
      og_type           TEXT,
      content_type      TEXT,
      http_status       INTEGER,
      summary           TEXT,
      kind              TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      error             TEXT,
      fetched_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_page_metadata_status
      ON page_metadata(status);

    CREATE TABLE IF NOT EXISTS domain_catalog (
      domain        TEXT PRIMARY KEY,
      title         TEXT,
      site_name     TEXT,
      description   TEXT,
      can_do        TEXT,
      kind          TEXT,
      notes         TEXT,
      user_edited   INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'pending',
      error         TEXT,
      fetched_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS server_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      type         TEXT NOT NULL,
      occurred_at  TEXT NOT NULL,
      ended_at     TEXT,
      duration_ms  INTEGER,
      details_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_server_events_at
      ON server_events(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_server_events_type
      ON server_events(type);

    CREATE TABLE IF NOT EXISTS visit_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      url         TEXT NOT NULL,
      domain      TEXT,
      title       TEXT,
      visited_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_visit_events_visited_at
      ON visit_events(visited_at DESC);
    CREATE INDEX IF NOT EXISTS idx_visit_events_domain
      ON visit_events(domain);

    CREATE TABLE IF NOT EXISTS diary_entries (
      date                  TEXT PRIMARY KEY,
      summary               TEXT,
      work_content          TEXT,
      highlights            TEXT,
      notes                 TEXT,
      metrics_json          TEXT,
      github_commits_json   TEXT,
      status                TEXT NOT NULL DEFAULT 'pending',
      error                 TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS weekly_reports (
      week_start            TEXT PRIMARY KEY,
      week_end              TEXT NOT NULL,
      month                 TEXT NOT NULL,
      week_in_month         INTEGER NOT NULL,
      summary               TEXT,
      github_summary_json   TEXT,
      status                TEXT NOT NULL DEFAULT 'pending',
      error                 TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_weekly_month
      ON weekly_reports(month);

    CREATE TABLE IF NOT EXISTS diary_settings (
      key    TEXT PRIMARY KEY,
      value  TEXT
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS dictionary_entries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      term         TEXT NOT NULL UNIQUE,
      definition   TEXT,
      notes        TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS dictionary_links (
      entry_id      INTEGER NOT NULL REFERENCES dictionary_entries(id) ON DELETE CASCADE,
      source_kind   TEXT NOT NULL,
      source_id     INTEGER NOT NULL,
      added_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (entry_id, source_kind, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dict_links_entry
      ON dictionary_links(entry_id);
    CREATE INDEX IF NOT EXISTS idx_dict_links_source
      ON dictionary_links(source_kind, source_id);

    CREATE TABLE IF NOT EXISTS word_clouds (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      origin              TEXT NOT NULL,
      origin_dig_id       INTEGER,
      origin_bookmark_id  INTEGER REFERENCES bookmarks(id) ON DELETE CASCADE,
      parent_cloud_id     INTEGER,
      parent_word         TEXT,
      label               TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      error               TEXT,
      result_json         TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_word_clouds_created
      ON word_clouds(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_word_clouds_bookmark
      ON word_clouds(origin_bookmark_id);

    CREATE TABLE IF NOT EXISTS gps_locations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT NOT NULL DEFAULT 'me',
      device_id     TEXT,
      recorded_at   TEXT NOT NULL,
      lat           REAL NOT NULL,
      lon           REAL NOT NULL,
      accuracy_m    REAL,
      altitude_m    REAL,
      velocity_kmh  REAL,
      course_deg    REAL,
      battery_pct   INTEGER,
      conn          TEXT,
      raw_json      TEXT,
      received_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_gps_locations_at
      ON gps_locations(recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gps_locations_user_at
      ON gps_locations(user_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gps_locations_dedup
      ON gps_locations(user_id, device_id, recorded_at);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint    TEXT NOT NULL UNIQUE,
      p256dh      TEXT NOT NULL,
      auth        TEXT NOT NULL,
      label       TEXT,
      user_agent  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_active
      ON push_subscriptions(revoked_at) WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS meals (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      photo_path                  TEXT NOT NULL,
      eaten_at                    TEXT NOT NULL,
      eaten_at_source             TEXT NOT NULL DEFAULT 'manual',
      lat                         REAL,
      lon                         REAL,
      location_label              TEXT,
      location_source             TEXT,
      description                 TEXT,
      calories                    INTEGER,
      items_json                  TEXT,
      nutrients_json              TEXT,
      ai_status                   TEXT NOT NULL DEFAULT 'pending',
      ai_error                    TEXT,
      user_note                   TEXT,
      user_corrected_description  TEXT,
      user_corrected_calories     INTEGER,
      additions_json              TEXT,
      created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_meals_eaten_at ON meals(eaten_at DESC);
    CREATE INDEX IF NOT EXISTS idx_meals_ai_status ON meals(ai_status);
  `);

  // Forward-compat: 既存 DB に列を ALTER で追加
  const mealsCols = db.prepare(`PRAGMA table_info(meals)`).all().map(c => c.name);
  if (mealsCols.length > 0 && !mealsCols.includes('additions_json')) {
    db.exec(`ALTER TABLE meals ADD COLUMN additions_json TEXT`);
  }
  if (mealsCols.length > 0 && !mealsCols.includes('nutrients_json')) {
    db.exec(`ALTER TABLE meals ADD COLUMN nutrients_json TEXT`);
  }

  // Forward-compat: ensure newer columns exist on older word_clouds tables.
  const wcCols = db.prepare(`PRAGMA table_info(word_clouds)`).all().map(c => c.name);
  if (!wcCols.includes('origin_bookmark_id')) {
    db.exec(`ALTER TABLE word_clouds ADD COLUMN origin_bookmark_id INTEGER`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_word_clouds_bookmark ON word_clouds(origin_bookmark_id)`);
  }

  const dsCols = db.prepare(`PRAGMA table_info(dig_sessions)`).all().map(c => c.name);
  if (!dsCols.includes('preview_json')) {
    db.exec(`ALTER TABLE dig_sessions ADD COLUMN preview_json TEXT`);
  }
  if (!dsCols.includes('theme')) {
    db.exec(`ALTER TABLE dig_sessions ADD COLUMN theme TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_dig_sessions_theme
              ON dig_sessions(theme, created_at DESC)`);
  }
  // Raw SERP scrape (no LLM) — populated within ~2s of dig submit so the UI
  // can show Google-style hits instantly. Lives alongside `preview_json`
  // (Claude's annotated overview) and `result_json` (full deep dig).
  if (!dsCols.includes('raw_results_json')) {
    db.exec(`ALTER TABLE dig_sessions ADD COLUMN raw_results_json TEXT`);
  }

  const deCols = db.prepare(`PRAGMA table_info(diary_entries)`).all().map(c => c.name);
  if (!deCols.includes('work_content')) db.exec(`ALTER TABLE diary_entries ADD COLUMN work_content TEXT`);
  if (!deCols.includes('highlights'))   db.exec(`ALTER TABLE diary_entries ADD COLUMN highlights TEXT`);
  // Sonnet (`diary_work`) infers focused work minutes from the URL timeline
  // and writes it here. Replaces the visit_events session heuristic, which
  // over-counted days with long idle browser tabs (see trendsWorkHours).
  if (!deCols.includes('work_minutes')) db.exec(`ALTER TABLE diary_entries ADD COLUMN work_minutes INTEGER`);

  const dcCols = db.prepare(`PRAGMA table_info(domain_catalog)`).all().map(c => c.name);
  if (!dcCols.includes('site_name'))   db.exec(`ALTER TABLE domain_catalog ADD COLUMN site_name TEXT`);
  if (!dcCols.includes('can_do'))      db.exec(`ALTER TABLE domain_catalog ADD COLUMN can_do TEXT`);
  if (!dcCols.includes('notes'))       db.exec(`ALTER TABLE domain_catalog ADD COLUMN notes TEXT`);
  if (!dcCols.includes('user_edited')) db.exec(`ALTER TABLE domain_catalog ADD COLUMN user_edited INTEGER NOT NULL DEFAULT 0`);

  // Phase 1 (multi-server): ownership / share metadata on the three shareable
  // resources. NULL owner_user_id = "this is mine" on a local server.
  // Same columns exist on the multi-server schema (Postgres) — see docs/.
  const shareCols = ['owner_user_id', 'owner_user_name', 'shared_at', 'shared_origin'];
  for (const tbl of ['bookmarks', 'dictionary_entries', 'dig_sessions']) {
    const existing = db.prepare(`PRAGMA table_info(${tbl})`).all().map(c => c.name);
    for (const col of shareCols) {
      if (!existing.includes(col)) db.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col} TEXT`);
    }
  }

  // Forward-compat: ensure newer columns exist on older DBs.
  const cols = db.prepare(`PRAGMA table_info(bookmarks)`).all().map(c => c.name);
  if (!cols.includes('last_accessed_at')) {
    db.exec(`ALTER TABLE bookmarks ADD COLUMN last_accessed_at TEXT`);
  }
  if (!cols.includes('access_count')) {
    db.exec(`ALTER TABLE bookmarks ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`);
  }

  return db;
}
