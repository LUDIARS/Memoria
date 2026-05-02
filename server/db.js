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

    -- 開発系の活動イベント (git commit / Claude Code prompt 等) を時系列で保存。
    -- ブラウザ閲覧 (visit_events) では拾えない作業 (スマホ開発、 ターミナル作業
    -- 中心の日) を可視化し、 仕事時間推定の根拠にする。
    -- kind: 'git_commit' | 'claude_code_prompt' (将来追加可能)
    -- source: kind 別の文脈 (リポ名 / セッション ID 等)
    -- ref_id: 一意性のあるキー (commit sha / prompt UUID) — 重複登録防止
    -- content: 短い本文 (commit message 1 行目 / プロンプト先頭〜200 文字)
    -- metadata_json: JSON で kind 別の追加情報 (branch, author, model, cwd 等)
    CREATE TABLE IF NOT EXISTS activity_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      kind          TEXT NOT NULL,
      occurred_at   TEXT NOT NULL,
      source        TEXT,
      ref_id        TEXT,
      content       TEXT,
      metadata_json TEXT,
      ingested_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_activity_events_at
      ON activity_events(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_events_kind_at
      ON activity_events(kind, occurred_at DESC);
    -- 同一 ref_id (sha 等) の重複登録を防ぐ — kind+ref_id の組で一意。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_events_ref
      ON activity_events(kind, ref_id) WHERE ref_id IS NOT NULL;

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

  // visit_events: external タップ (Legatus DNS / SNI) 対応カラム
  // device_label = Tailscale でタグ付けされた発信元 (例: "iphone-of-foo")
  // device_os    = "iOS" / "Android" / "macOS" / "Windows" / "Linux" / null
  // source       = "browser" (拡張機能からの POST), "dns" (Legatus dnstap),
  //                "sni" (Legatus SNI tap, 将来拡張)
  const veCols = db.prepare(`PRAGMA table_info(visit_events)`).all().map(c => c.name);
  if (!veCols.includes('device_label')) db.exec(`ALTER TABLE visit_events ADD COLUMN device_label TEXT`);
  if (!veCols.includes('device_os'))    db.exec(`ALTER TABLE visit_events ADD COLUMN device_os TEXT`);
  if (!veCols.includes('source'))       db.exec(`ALTER TABLE visit_events ADD COLUMN source TEXT`);

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

// ── push_subscriptions DAO ────────────────────────────────────

export function findPushSubscriptionByEndpoint(db, endpoint) {
  return db.prepare(`SELECT * FROM push_subscriptions WHERE endpoint = ?`).get(endpoint);
}

export function listActivePushSubscriptions(db) {
  return db.prepare(`
    SELECT id, endpoint, p256dh, auth, label, user_agent, created_at
    FROM push_subscriptions
    WHERE revoked_at IS NULL
    ORDER BY created_at DESC
  `).all();
}

export function listPushSubscriptions(db) {
  return db.prepare(`
    SELECT id, endpoint, label, user_agent, created_at, revoked_at
    FROM push_subscriptions
    ORDER BY (revoked_at IS NOT NULL), created_at DESC
  `).all();
}

/**
 * Insert / update a subscription. If `id` is supplied the row is upserted
 * (used to re-enable a revoked endpoint without losing its label).
 * Returns the row id.
 */
export function insertPushSubscription(db, { id, endpoint, p256dh, auth, label, userAgent, revokedAt }) {
  if (id) {
    db.prepare(`
      UPDATE push_subscriptions
      SET endpoint = ?, p256dh = ?, auth = ?, label = ?, user_agent = ?, revoked_at = ?
      WHERE id = ?
    `).run(endpoint, p256dh, auth, label ?? null, userAgent ?? null, revokedAt ?? null, id);
    return id;
  }
  const info = db.prepare(`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `).run(endpoint, p256dh, auth, label ?? null, userAgent ?? null);
  return info.lastInsertRowid;
}

export function markPushSubscriptionRevoked(db, id) {
  db.prepare(`UPDATE push_subscriptions SET revoked_at = datetime('now') WHERE id = ?`).run(id);
}

export function deletePushSubscription(db, id) {
  const info = db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(id);
  return info.changes;
}

// ── bookmarks DAO ─────────────────────────────────────────────

/**
 * List bookmarks with optional category / search / pagination.
 *
 * - `q` does a SQL LIKE across title / url / summary so the front-end
 *   doesn't have to keep all rows in memory just to do client-side filtering
 *   (the original UI fetched everything and filtered locally — fine at
 *   100 bookmarks, painful at thousands).
 * - `limit` is opt-in. Internal callers that want every bookmark (cloud
 *   extraction, export, recommendations) keep working unchanged because
 *   the function still returns a plain array; pagination is only applied
 *   when `limit` is a positive number. Use `countBookmarks` for the total
 *   when paginating.
 */
export function listBookmarks(db, { category, sort = 'created_desc', limit, offset = 0, q } = {}) {
  const orderClauses = {
    created_desc: 'b.created_at DESC',
    created_asc: 'b.created_at ASC',
    accessed_desc: 'COALESCE(b.last_accessed_at, b.created_at) DESC',
    accessed_asc: 'COALESCE(b.last_accessed_at, b.created_at) ASC',
    title_asc: 'b.title ASC',
  };
  const orderBy = orderClauses[sort] ?? orderClauses.created_desc;
  const where = [];
  const params = [];
  let join = '';
  if (category) {
    join = 'JOIN bookmark_categories bc ON bc.bookmark_id = b.id';
    where.push('bc.category = ?');
    params.push(category);
  }
  if (q) {
    where.push('(b.title LIKE ? OR b.url LIKE ? OR COALESCE(b.summary, \'\') LIKE ?)');
    const pat = `%${q}%`;
    params.push(pat, pat, pat);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let sql = `SELECT b.* FROM bookmarks b ${join} ${whereClause} ORDER BY ${orderBy}`;
  const queryParams = [...params];
  if (Number.isFinite(limit) && limit > 0) {
    sql += ' LIMIT ? OFFSET ?';
    queryParams.push(Math.floor(limit), Math.max(0, Math.floor(offset) || 0));
  }
  const rows = db.prepare(sql).all(...queryParams);
  return rows.map(r => ({ ...r, categories: getCategories(db, r.id) }));
}

/** Count bookmarks matching the same filters as `listBookmarks`. Cheaper
 * than fetching everything just to check `length`, and lets the UI show
 * "全 N 件中 M 件表示中" when paginating. */
export function countBookmarks(db, { category, q } = {}) {
  const where = [];
  const params = [];
  let join = '';
  if (category) {
    join = 'JOIN bookmark_categories bc ON bc.bookmark_id = b.id';
    where.push('bc.category = ?');
    params.push(category);
  }
  if (q) {
    where.push('(b.title LIKE ? OR b.url LIKE ? OR COALESCE(b.summary, \'\') LIKE ?)');
    const pat = `%${q}%`;
    params.push(pat, pat, pat);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const row = db.prepare(`SELECT COUNT(DISTINCT b.id) AS n FROM bookmarks b ${join} ${whereClause}`).get(...params);
  return row.n;
}

export function getBookmark(db, id) {
  const row = db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).get(id);
  if (!row) return null;
  return { ...row, categories: getCategories(db, id) };
}

export function getCategories(db, bookmarkId) {
  return db.prepare(`SELECT category FROM bookmark_categories WHERE bookmark_id = ? ORDER BY category`)
    .all(bookmarkId)
    .map(r => r.category);
}

export function listAllCategories(db) {
  return db.prepare(`
    SELECT category, COUNT(*) AS count
    FROM bookmark_categories
    GROUP BY category
    ORDER BY count DESC, category ASC
  `).all();
}

export function insertBookmark(db, { url, title, htmlPath }) {
  const stmt = db.prepare(`
    INSERT INTO bookmarks (url, title, html_path) VALUES (?, ?, ?)
  `);
  const info = stmt.run(url, title, htmlPath);
  return info.lastInsertRowid;
}

export function findBookmarkByUrl(db, url) {
  return db.prepare(`SELECT * FROM bookmarks WHERE url = ? ORDER BY id DESC LIMIT 1`).get(url) ?? null;
}

export function setSummary(db, id, { summary, categories, status, error }) {
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE bookmarks
      SET summary = ?, status = ?, error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(summary ?? null, status, error ?? null, id);

    if (Array.isArray(categories)) {
      db.prepare(`DELETE FROM bookmark_categories WHERE bookmark_id = ?`).run(id);
      const ins = db.prepare(`INSERT OR IGNORE INTO bookmark_categories (bookmark_id, category) VALUES (?, ?)`);
      for (const cat of categories) {
        const trimmed = String(cat).trim();
        if (trimmed) ins.run(id, trimmed);
      }
    }
  });
  tx();
}

export function updateMemoAndCategories(db, id, { memo, categories }) {
  const tx = db.transaction(() => {
    if (typeof memo === 'string') {
      db.prepare(`UPDATE bookmarks SET memo = ?, updated_at = datetime('now') WHERE id = ?`).run(memo, id);
    }
    if (Array.isArray(categories)) {
      db.prepare(`DELETE FROM bookmark_categories WHERE bookmark_id = ?`).run(id);
      const ins = db.prepare(`INSERT OR IGNORE INTO bookmark_categories (bookmark_id, category) VALUES (?, ?)`);
      for (const cat of categories) {
        const trimmed = String(cat).trim();
        if (trimmed) ins.run(id, trimmed);
      }
    }
  });
  tx();
}

/** Upsert a visit row for any URL (whether bookmarked or not). */
export function upsertVisit(db, { url, title }) {
  db.prepare(`
    INSERT INTO page_visits (url, title)
    VALUES (?, ?)
    ON CONFLICT(url) DO UPDATE SET
      title = COALESCE(NULLIF(excluded.title, ''), page_visits.title),
      last_seen_at = datetime('now'),
      visit_count = page_visits.visit_count + 1
  `).run(url, title ?? null);
}

/**
 * URLs visited today (local time) that are NOT yet bookmarked.
 * `since` is an optional ISO string lower bound; default = start of local day.
 */
export function listUnsavedVisits(db, { since } = {}) {
  const sinceClause = since
    ? `v.last_seen_at >= ?`
    : `date(v.last_seen_at, 'localtime') = date('now', 'localtime')`;
  const args = since ? [since] : [];
  return db.prepare(`
    SELECT v.url, v.title, v.first_seen_at, v.last_seen_at, v.visit_count
    FROM page_visits v
    LEFT JOIN bookmarks b ON b.url = v.url
    WHERE b.id IS NULL
      AND ${sinceClause}
    ORDER BY v.last_seen_at DESC
  `).all(...args);
}

export function deleteVisit(db, url) {
  db.prepare(`DELETE FROM page_visits WHERE url = ?`).run(url);
}

/**
 * Unsaved visits enriched with domain stats and a "miss-bookmark likelihood" score.
 * The intent is to surface URLs that the user is probably reading but hasn't bookmarked
 * because the same domain (or path prefix) is already in their library.
 */
export function listSuggestedVisits(db, { sinceDays = 30 } = {}) {
  const visits = db.prepare(`
    SELECT v.url, v.title, v.first_seen_at, v.last_seen_at, v.visit_count
    FROM page_visits v
    LEFT JOIN bookmarks b ON b.url = v.url
    WHERE b.id IS NULL
      AND v.last_seen_at >= datetime('now', ?)
    ORDER BY v.last_seen_at DESC
  `).all(`-${Number(sinceDays) || 30} days`);

  const bookmarkUrls = db.prepare(`SELECT url FROM bookmarks`).all().map(r => r.url);
  const domainCounts = new Map();
  const pathPrefixIndex = new Map();
  for (const u of bookmarkUrls) {
    const d = extractDomain(u);
    if (!d) continue;
    domainCounts.set(d, (domainCounts.get(d) || 0) + 1);
    const segs = firstPathSegment(u);
    if (segs) {
      if (!pathPrefixIndex.has(d)) pathPrefixIndex.set(d, new Set());
      pathPrefixIndex.get(d).add(segs);
    }
  }

  return visits.map(v => {
    const domain = extractDomain(v.url);
    const firstSeg = firstPathSegment(v.url);
    const sameDomain = domain ? (domainCounts.get(domain) || 0) : 0;
    const samePrefix = (domain && firstSeg && pathPrefixIndex.get(domain)?.has(firstSeg)) ? 1 : 0;
    const score = sameDomain * 10 + samePrefix * 8 + Math.min(v.visit_count || 1, 20) * 2;
    return {
      ...v,
      domain,
      same_domain_bookmarks: sameDomain,
      same_path_prefix_bookmarks: samePrefix,
      score,
    };
  }).sort((a, b) => b.score - a.score || (a.last_seen_at < b.last_seen_at ? 1 : -1));
}

// ── dig sessions ----------------------------------------------------------

export function insertDigSession(db, query, theme = null) {
  return db
    .prepare(`INSERT INTO dig_sessions (query, theme) VALUES (?, ?)`)
    .run(query, theme || null).lastInsertRowid;
}

export function setDigResult(db, id, { status, result, error }) {
  db.prepare(`
    UPDATE dig_sessions SET status = ?, result_json = ?, error = ?
    WHERE id = ?
  `).run(status, result ? JSON.stringify(result) : null, error ?? null, id);
}

export function setDigPreview(db, id, preview) {
  db.prepare(`UPDATE dig_sessions SET preview_json = ? WHERE id = ?`)
    .run(preview ? JSON.stringify(preview) : null, id);
}

/** Persist the no-AI SERP scrape (`runDigRawSerp` output). Called as soon
 * as the scrape lands so the FE can render Google-style results before any
 * Claude phase finishes. */
export function setDigRawResults(db, id, raw) {
  db.prepare(`UPDATE dig_sessions SET raw_results_json = ? WHERE id = ?`)
    .run(raw ? JSON.stringify(raw) : null, id);
}

/**
 * Drop a dig session. Used to clean up 誤 Dig (mis-typed query, junk results,
 * etc.). 関連レコード:
 *   - dictionary_links (source_kind='dig', source_id=id) — 残しても 「Dig
 *     ソース消失」 と表示されるだけなので壊れない
 *   - word_clouds (origin_dig_id=id) — 同上 (origin_dig_id が orphan になる
 *     だけ)
 * 走行中の queue ジョブが後から `setDigResult` を呼んでも、 行が無いので
 * UPDATE が何もしないだけで安全。
 */
export function deleteDigSession(db, id) {
  const info = db.prepare(`DELETE FROM dig_sessions WHERE id = ?`).run(id);
  return info.changes;
}

export function getDigSession(db, id) {
  const row = db.prepare(`SELECT * FROM dig_sessions WHERE id = ?`).get(id);
  if (!row) return null;
  return {
    ...row,
    result: row.result_json ? safeParse(row.result_json) : null,
    preview: row.preview_json ? safeParse(row.preview_json) : null,
    raw_results: row.raw_results_json ? safeParse(row.raw_results_json) : null,
  };
}

export function listDigSessions(db, { theme, limit = 30 } = {}) {
  if (theme) {
    return db.prepare(`
      SELECT id, query, theme, status, created_at FROM dig_sessions
      WHERE theme = ?
      ORDER BY id DESC LIMIT ?
    `).all(theme, limit);
  }
  return db.prepare(`
    SELECT id, query, theme, status, created_at FROM dig_sessions
    ORDER BY id DESC LIMIT ?
  `).all(limit);
}

/// テーマ一覧 (各テーマのセッション数 + 最新時刻 + 直近クエリ)。
/// theme = NULL のセッションは除外。
export function listDigThemes(db, limit = 60) {
  return db.prepare(`
    SELECT
      theme                      AS theme,
      COUNT(*)                   AS session_count,
      MAX(created_at)            AS last_at,
      (SELECT query FROM dig_sessions s2
        WHERE s2.theme = s.theme
        ORDER BY s2.created_at DESC LIMIT 1) AS last_query
    FROM dig_sessions s
    WHERE theme IS NOT NULL AND theme <> ''
    GROUP BY theme
    ORDER BY last_at DESC
    LIMIT ?
  `).all(limit);
}

/// あるテーマで過去に取得した topics / source 情報をまとめる。
/// LLM プロンプトに渡すコンテキスト用。
export function digThemeContext(db, theme, { limit = 8 } = {}) {
  const sessions = db.prepare(`
    SELECT id, query, result_json FROM dig_sessions
    WHERE theme = ? AND status = 'done' AND result_json IS NOT NULL
    ORDER BY id DESC LIMIT ?
  `).all(theme, limit);
  const topics = new Map(); // topic -> count
  const sources = []; // {url, title}
  const queries = [];
  for (const s of sessions) {
    queries.push(s.query);
    const r = safeParse(s.result_json);
    if (!r) continue;
    for (const src of r.sources || []) {
      if (src.url && sources.length < 30) {
        sources.push({ url: src.url, title: src.title || '' });
      }
      for (const t of src.topics || []) {
        const k = String(t).trim().toLowerCase();
        if (!k) continue;
        topics.set(k, (topics.get(k) || 0) + 1);
      }
    }
  }
  const topTopics = [...topics.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([word, count]) => ({ word, count }));
  return { queries, topics: topTopics, sources };
}

/** Dig sessions whose created_at falls on the given local date. */
export function digSessionsForDate(db, dateStr) {
  const rows = db.prepare(`
    SELECT * FROM dig_sessions
    WHERE date(created_at, 'localtime') = ?
    ORDER BY created_at ASC
  `).all(dateStr);
  return rows.map(r => ({
    ...r,
    result: r.result_json ? safeParse(r.result_json) : null,
    preview: r.preview_json ? safeParse(r.preview_json) : null,
  }));
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

// ── share metadata --------------------------------------------------------
//
// Mark a local row as having been forwarded to a multi server. owner_user_id
// stays NULL on the local side (NULL = "this is mine") — the multi-side row
// is the one that carries the Cernere user id. shared_origin records the
// remote we forwarded to so re-shares can be detected later.
//
// Downloaded rows go the other way: they came from a multi server, so we set
// owner_user_id / owner_user_name to the remote owner so the UI can render
// "by <user>" without confusing them with rows the user authored locally.
export function setBookmarkOwner(db, id, { ownerUserId, ownerUserName, sharedAt, sharedOrigin }) {
  db.prepare(`UPDATE bookmarks SET owner_user_id = ?, owner_user_name = ?, shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(ownerUserId, ownerUserName, sharedAt, sharedOrigin, id);
}

export function setDigOwner(db, id, { ownerUserId, ownerUserName, sharedAt, sharedOrigin }) {
  db.prepare(`UPDATE dig_sessions SET owner_user_id = ?, owner_user_name = ?, shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(ownerUserId, ownerUserName, sharedAt, sharedOrigin, id);
}

export function setDictionaryOwner(db, id, { ownerUserId, ownerUserName, sharedAt, sharedOrigin }) {
  db.prepare(`UPDATE dictionary_entries SET owner_user_id = ?, owner_user_name = ?, shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(ownerUserId, ownerUserName, sharedAt, sharedOrigin, id);
}

export function markBookmarkShared(db, id, { sharedAt, sharedOrigin }) {
  db.prepare(`UPDATE bookmarks SET shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(sharedAt, sharedOrigin, id);
}

export function markDigShared(db, id, { sharedAt, sharedOrigin }) {
  db.prepare(`UPDATE dig_sessions SET shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(sharedAt, sharedOrigin, id);
}

export function markDictionaryShared(db, id, { sharedAt, sharedOrigin }) {
  db.prepare(`UPDATE dictionary_entries SET shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(sharedAt, sharedOrigin, id);
}

// ── app settings (key/value) ----------------------------------------------

export function getAppSettings(db) {
  const rows = db.prepare(`SELECT key, value FROM app_settings`).all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// Keys whose stored row should be DELETED when the user clears them
// (credentials / one-shot session info — empty string == cleared and we
// don't want stale rows lying around). Everything else preserves an
// empty string as an empty string so plain text fields like
// `diary.global_memo` don't get auto-wiped when the user happens to
// save the panel with the textarea empty for a moment.
const DELETE_ON_EMPTY_KEYS = new Set([
  'multi_jwt', 'multi_user_id', 'multi_user_name', 'multi_role',
  'multi_connected_at', 'multi_url',
  'llm.openai.api_key',
  'github_token',
]);

export function setAppSettings(db, patch) {
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || (v === '' && DELETE_ON_EMPTY_KEYS.has(k))) {
        db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(k);
      } else {
        db.prepare(`
          INSERT INTO app_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(k, String(v));
      }
    }
  });
  tx();
}

// ── word clouds ------------------------------------------------------------

export function insertWordCloud(db, { origin, originDigId, parentCloudId, parentWord, label }) {
  return db.prepare(`
    INSERT INTO word_clouds (origin, origin_dig_id, parent_cloud_id, parent_word, label)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    origin,
    originDigId ?? null,
    parentCloudId ?? null,
    parentWord ?? null,
    label,
  ).lastInsertRowid;
}

export function setWordCloudResult(db, id, { status, result, error }) {
  db.prepare(`
    UPDATE word_clouds SET status = ?, result_json = ?, error = ?
    WHERE id = ?
  `).run(status, result ? JSON.stringify(result) : null, error ?? null, id);
}

export function getWordCloud(db, id) {
  const row = db.prepare(`SELECT * FROM word_clouds WHERE id = ?`).get(id);
  if (!row) return null;
  return {
    ...row,
    result: row.result_json ? safeParse(row.result_json) : null,
  };
}

export function listWordClouds(db, limit = 30) {
  return db.prepare(`
    SELECT id, origin, origin_dig_id, origin_bookmark_id, parent_cloud_id, parent_word,
           label, status, created_at
    FROM word_clouds ORDER BY id DESC LIMIT ?
  `).all(limit);
}

/** Latest 'done' word cloud for a single bookmark, or null. */
export function getBookmarkWordCloud(db, bookmarkId) {
  const row = db.prepare(`
    SELECT * FROM word_clouds
    WHERE origin = 'bookmark' AND origin_bookmark_id = ? AND status = 'done'
    ORDER BY id DESC LIMIT 1
  `).get(bookmarkId);
  if (!row) return null;
  return { ...row, result: row.result_json ? safeParse(row.result_json) : null };
}

/** Most recent 'done' bookmark clouds (for recommendation weighting). */
export function recentBookmarkWordClouds(db, { limit = 50 } = {}) {
  const rows = db.prepare(`
    SELECT wc.* FROM word_clouds wc
    JOIN bookmarks b ON b.id = wc.origin_bookmark_id
    WHERE wc.origin = 'bookmark' AND wc.status = 'done'
    ORDER BY b.created_at DESC LIMIT ?
  `).all(Number(limit) || 50);
  return rows.map(r => ({
    bookmark_id: r.origin_bookmark_id,
    label: r.label,
    result: r.result_json ? safeParse(r.result_json) : null,
  }));
}

// ── dictionary -------------------------------------------------------------

export function listDictionaryEntries(db, { search } = {}) {
  const args = [];
  let where = '';
  if (search) {
    where = `WHERE e.term LIKE ? OR e.definition LIKE ? OR e.notes LIKE ?`;
    const pat = `%${search}%`;
    args.push(pat, pat, pat);
  }
  const rows = db.prepare(`
    SELECT e.*, COALESCE(l.link_count, 0) AS link_count
    FROM dictionary_entries e
    LEFT JOIN (
      SELECT entry_id, COUNT(*) AS link_count
      FROM dictionary_links GROUP BY entry_id
    ) l ON l.entry_id = e.id
    ${where}
    ORDER BY e.updated_at DESC
  `).all(...args);
  return rows;
}

export function getDictionaryEntry(db, id) {
  const row = db.prepare(`SELECT * FROM dictionary_entries WHERE id = ?`).get(id);
  if (!row) return null;
  const links = db.prepare(`
    SELECT source_kind, source_id, added_at
    FROM dictionary_links WHERE entry_id = ?
    ORDER BY added_at DESC
  `).all(id);
  return { ...row, links };
}

export function findDictionaryEntryByTerm(db, term) {
  return db.prepare(`SELECT * FROM dictionary_entries WHERE term = ?`).get(term) ?? null;
}

export function insertDictionaryEntry(db, { term, definition, notes }) {
  const info = db.prepare(`
    INSERT INTO dictionary_entries (term, definition, notes)
    VALUES (?, ?, ?)
  `).run(String(term).trim(), definition ?? null, notes ?? null);
  return info.lastInsertRowid;
}

export function updateDictionaryEntry(db, id, patch) {
  const fields = [];
  const args = [];
  if (typeof patch.term === 'string') { fields.push('term = ?'); args.push(patch.term.trim()); }
  if (typeof patch.definition === 'string' || patch.definition === null) {
    fields.push('definition = ?'); args.push(patch.definition);
  }
  if (typeof patch.notes === 'string' || patch.notes === null) {
    fields.push('notes = ?'); args.push(patch.notes);
  }
  if (fields.length === 0) return;
  fields.push(`updated_at = datetime('now')`);
  args.push(id);
  db.prepare(`UPDATE dictionary_entries SET ${fields.join(', ')} WHERE id = ?`).run(...args);
}

export function deleteDictionaryEntry(db, id) {
  db.prepare(`DELETE FROM dictionary_entries WHERE id = ?`).run(id);
}

export function addDictionaryLink(db, { entryId, sourceKind, sourceId }) {
  db.prepare(`
    INSERT OR IGNORE INTO dictionary_links (entry_id, source_kind, source_id)
    VALUES (?, ?, ?)
  `).run(entryId, sourceKind, sourceId);
}

export function removeDictionaryLink(db, { entryId, sourceKind, sourceId }) {
  db.prepare(`
    DELETE FROM dictionary_links
    WHERE entry_id = ? AND source_kind = ? AND source_id = ?
  `).run(entryId, sourceKind, sourceId);
}

// ── page metadata (per-URL) -----------------------------------------------

export function getPageMetadata(db, url) {
  return db.prepare(`SELECT * FROM page_metadata WHERE url = ?`).get(url) ?? null;
}

export function getPageMetadataMap(db, urls) {
  if (!urls.length) return new Map();
  const placeholders = urls.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM page_metadata WHERE url IN (${placeholders})`).all(...urls);
  return new Map(rows.map(r => [r.url, r]));
}

export function insertPageMetadataPending(db, url) {
  db.prepare(`
    INSERT OR IGNORE INTO page_metadata (url, status) VALUES (?, 'pending')
  `).run(url);
}

export function setPageMetadata(db, url, patch) {
  db.prepare(`
    UPDATE page_metadata
       SET title = COALESCE(?, title),
           meta_description = COALESCE(?, meta_description),
           og_title = COALESCE(?, og_title),
           og_description = COALESCE(?, og_description),
           og_image = COALESCE(?, og_image),
           og_type = COALESCE(?, og_type),
           content_type = COALESCE(?, content_type),
           http_status = COALESCE(?, http_status),
           summary = COALESCE(?, summary),
           kind = COALESCE(?, kind),
           status = COALESCE(?, status),
           error = ?,
           fetched_at = datetime('now')
     WHERE url = ?
  `).run(
    patch.title ?? null,
    patch.meta_description ?? null,
    patch.og_title ?? null,
    patch.og_description ?? null,
    patch.og_image ?? null,
    patch.og_type ?? null,
    patch.content_type ?? null,
    patch.http_status ?? null,
    patch.summary ?? null,
    patch.kind ?? null,
    patch.status ?? null,
    patch.error ?? null,
    url,
  );
}

export function deletePageMetadata(db, url) {
  db.prepare(`DELETE FROM page_metadata WHERE url = ?`).run(url);
}

// ── domain catalog ---------------------------------------------------------

export function getDomainCatalog(db, domain) {
  return db.prepare(`SELECT * FROM domain_catalog WHERE domain = ?`).get(domain) ?? null;
}

export function listDomainCatalog(db, { limit = 200 } = {}) {
  return db.prepare(`
    SELECT * FROM domain_catalog
    ORDER BY (status = 'done') DESC, fetched_at DESC
    LIMIT ?
  `).all(limit);
}

/** Bulk fetch by domain set; returns { domain → row }. */
export function getDomainCatalogMap(db, domains) {
  if (!domains.length) return new Map();
  const placeholders = domains.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM domain_catalog WHERE domain IN (${placeholders})`).all(...domains);
  return new Map(rows.map(r => [r.domain, r]));
}

export function insertDomainPending(db, domain) {
  db.prepare(`
    INSERT OR IGNORE INTO domain_catalog (domain, status) VALUES (?, 'pending')
  `).run(domain);
}

export function setDomainCatalog(db, domain, patch) {
  // Don't clobber user-edited columns. Caller should pass only the fields
  // it produced; we COALESCE so untouched columns keep their value.
  db.prepare(`
    UPDATE domain_catalog
       SET title = COALESCE(?, title),
           site_name = CASE WHEN user_edited = 1 THEN site_name ELSE COALESCE(?, site_name) END,
           description = CASE WHEN user_edited = 1 THEN description ELSE COALESCE(?, description) END,
           can_do = CASE WHEN user_edited = 1 THEN can_do ELSE COALESCE(?, can_do) END,
           kind = CASE WHEN user_edited = 1 THEN kind ELSE COALESCE(?, kind) END,
           status = COALESCE(?, status),
           error = ?,
           fetched_at = datetime('now')
     WHERE domain = ?
  `).run(
    patch.title ?? null,
    patch.site_name ?? null,
    patch.description ?? null,
    patch.can_do ?? null,
    patch.kind ?? null,
    patch.status ?? null,
    patch.error ?? null,
    domain,
  );
}

export function updateDomainCatalogUser(db, domain, patch) {
  // User edit. Mark user_edited=1 so the auto-classifier won't overwrite.
  const fields = [];
  const args = [];
  for (const k of ['site_name', 'description', 'can_do', 'kind', 'notes']) {
    if (typeof patch[k] === 'string' || patch[k] === null) {
      fields.push(`${k} = ?`);
      args.push(patch[k] ?? null);
    }
  }
  if (fields.length === 0) return;
  fields.push(`user_edited = 1`);
  args.push(domain);
  db.prepare(`UPDATE domain_catalog SET ${fields.join(', ')} WHERE domain = ?`).run(...args);
}

export function listDomainCatalogWithCounts(db, { limit = 500, search } = {}) {
  const args = [];
  let where = '';
  if (search) {
    where = `WHERE c.domain LIKE ? OR c.site_name LIKE ? OR c.description LIKE ? OR c.can_do LIKE ?`;
    const pat = `%${search}%`;
    args.push(pat, pat, pat, pat);
  }
  const rows = db.prepare(`
    SELECT c.*,
           COALESCE(d.daily_visits, 0)    AS visits_today,
           COALESCE(w.weekly_visits, 0)   AS visits_week,
           COALESCE(t.total_visits, 0)    AS visits_total
      FROM domain_catalog c
      LEFT JOIN (
        SELECT instr(SUBSTR(url, INSTR(url, '://') + 3), '/') AS slash,
               LOWER(SUBSTR(SUBSTR(url, INSTR(url, '://') + 3), 1,
                            CASE WHEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') > 0
                                 THEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') - 1
                                 ELSE LENGTH(SUBSTR(url, INSTR(url, '://') + 3)) END
                           )) AS dom,
               SUM(visit_count) AS daily_visits
          FROM page_visits
         WHERE date(last_seen_at, 'localtime') = date('now', 'localtime')
         GROUP BY dom
      ) d ON d.dom = c.domain
      LEFT JOIN (
        SELECT LOWER(SUBSTR(SUBSTR(url, INSTR(url, '://') + 3), 1,
                            CASE WHEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') > 0
                                 THEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') - 1
                                 ELSE LENGTH(SUBSTR(url, INSTR(url, '://') + 3)) END
                           )) AS dom,
               SUM(visit_count) AS weekly_visits
          FROM page_visits
         WHERE last_seen_at >= datetime('now', '-7 days')
         GROUP BY dom
      ) w ON w.dom = c.domain
      LEFT JOIN (
        SELECT LOWER(SUBSTR(SUBSTR(url, INSTR(url, '://') + 3), 1,
                            CASE WHEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') > 0
                                 THEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') - 1
                                 ELSE LENGTH(SUBSTR(url, INSTR(url, '://') + 3)) END
                           )) AS dom,
               SUM(visit_count) AS total_visits
          FROM page_visits
         GROUP BY dom
      ) t ON t.dom = c.domain
     ${where}
     ORDER BY visits_today DESC, visits_week DESC, c.domain ASC
     LIMIT ?
  `).all(...args, Number(limit) || 500);
  return rows;
}

export function deleteDomainCatalog(db, domain) {
  db.prepare(`DELETE FROM domain_catalog WHERE domain = ?`).run(domain);
}

// ── server events (uptime / downtime / lifecycle) -------------------------

export function insertServerEvent(db, { type, occurredAt, endedAt, durationMs, details }) {
  return db.prepare(`
    INSERT INTO server_events (type, occurred_at, ended_at, duration_ms, details_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    type,
    occurredAt,
    endedAt ?? null,
    durationMs ?? null,
    details ? JSON.stringify(details) : null,
  ).lastInsertRowid;
}

export function listServerEvents(db, { limit = 200 } = {}) {
  const rows = db.prepare(`
    SELECT * FROM server_events
    ORDER BY id DESC LIMIT ?
  `).all(Number(limit) || 200);
  return rows.map(r => ({
    ...r,
    details: r.details_json ? safeParse(r.details_json) : null,
  }));
}

export function listServerEventsForDate(db, dateStr) {
  // Any event that overlaps the local date window.
  return db.prepare(`
    SELECT * FROM server_events
    WHERE date(occurred_at, 'localtime') = ?
       OR date(COALESCE(ended_at, occurred_at), 'localtime') = ?
    ORDER BY occurred_at ASC
  `).all(dateStr, dateStr).map(r => ({
    ...r, details: r.details_json ? safeParse(r.details_json) : null,
  }));
}

// ── activity events (git commit / claude code prompt 等) ─────────────────

const ACTIVITY_KINDS = new Set(['git_commit', 'claude_code_prompt']);

/**
 * 活動イベントを 1 件記録する。
 * kind+ref_id の重複は INSERT OR IGNORE で吸収 (同じ commit sha / prompt id が
 * 二度送られても重複しない)。 戻り値は inserted=true|false + id。
 */
export function recordActivityEvent(db, { kind, occurred_at, source, ref_id, content, metadata }) {
  if (!ACTIVITY_KINDS.has(kind)) {
    throw new Error(`unknown activity kind: ${kind}`);
  }
  const ts = occurred_at || new Date().toISOString();
  const info = db.prepare(`
    INSERT OR IGNORE INTO activity_events
      (kind, occurred_at, source, ref_id, content, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    kind,
    ts,
    source ?? null,
    ref_id ?? null,
    content ?? null,
    metadata ? JSON.stringify(metadata) : null,
  );
  return { inserted: info.changes > 0, id: info.lastInsertRowid };
}

/** 当日 (local) の活動イベントを時刻昇順で返す。 */
export function activityEventsForDate(db, dateStr) {
  return db.prepare(`
    SELECT id, kind, occurred_at, source, ref_id, content, metadata_json
    FROM activity_events
    WHERE date(occurred_at, 'localtime') = ?
    ORDER BY occurred_at ASC
  `).all(dateStr).map((r) => ({
    ...r,
    metadata: r.metadata_json ? safeParse(r.metadata_json) : null,
  }));
}

/** 直近 limit 件 (新しい順)。 全期間 / 任意 kind フィルタつき。 */
export function listActivityEvents(db, { limit = 200, kind = null } = {}) {
  const args = [];
  let where = '';
  if (kind && ACTIVITY_KINDS.has(kind)) {
    where = 'WHERE kind = ?';
    args.push(kind);
  }
  args.push(Number(limit) || 200);
  return db.prepare(`
    SELECT id, kind, occurred_at, source, ref_id, content, metadata_json, ingested_at
    FROM activity_events
    ${where}
    ORDER BY occurred_at DESC
    LIMIT ?
  `).all(...args).map((r) => ({
    ...r,
    metadata: r.metadata_json ? safeParse(r.metadata_json) : null,
  }));
}

// ── visit events / diary ---------------------------------------------------

export function insertVisitEvent(db, { url, title }) {
  const domain = extractDomain(url);
  db.prepare(`
    INSERT INTO visit_events (url, domain, title, source) VALUES (?, ?, ?, 'browser')
  `).run(url, domain, title ?? null);
}

/**
 * Insert a visit event sourced from outside the browser (e.g. Legatus DNS
 * tap on the user's home PC). `domain` は LFQDN (already lower-cased) を
 * 受ける前提。 url は擬似形式 (`dns://<domain>` or `sni://<domain>`) で
 * 保存し、 既存の page_visits / bookmark テーブルとは衝突させない。
 */
export function insertExternalVisitEvent(db, {
  domain,
  visitedAt,
  source,
  deviceLabel,
  deviceOs,
}) {
  const url = `${source}://${domain}`;
  db.prepare(`
    INSERT INTO visit_events (url, domain, title, visited_at, device_label, device_os, source)
    VALUES (?, ?, NULL, COALESCE(?, datetime('now')), ?, ?, ?)
  `).run(url, domain, visitedAt ?? null, deviceLabel ?? null, deviceOs ?? null, source);
}

/** Visit events for a single local date (YYYY-MM-DD). */
export function visitEventsForDate(db, dateStr) {
  return db.prepare(`
    SELECT id, url, domain, title, visited_at
    FROM visit_events
    WHERE date(visited_at, 'localtime') = ?
    ORDER BY visited_at ASC
  `).all(dateStr);
}

export function getDiary(db, dateStr) {
  const row = db.prepare(`SELECT * FROM diary_entries WHERE date = ?`).get(dateStr);
  if (!row) return null;
  return {
    ...row,
    metrics: row.metrics_json ? safeParse(row.metrics_json) : null,
    github_commits: row.github_commits_json ? safeParse(row.github_commits_json) : null,
  };
}

export function listDiariesInRange(db, { start, end }) {
  return db.prepare(`
    SELECT date, status, summary, notes, updated_at
    FROM diary_entries
    WHERE date >= ? AND date <= ?
    ORDER BY date ASC
  `).all(start, end);
}

export function upsertDiary(db, { date, summary, workContent, workMinutes, highlights, notes, metrics, githubCommits, status, error }) {
  const tx = db.transaction(() => {
    const exists = db.prepare(`SELECT date FROM diary_entries WHERE date = ?`).get(date);
    if (exists) {
      db.prepare(`
        UPDATE diary_entries
           SET summary = COALESCE(?, summary),
               work_content = COALESCE(?, work_content),
               work_minutes = COALESCE(?, work_minutes),
               highlights = COALESCE(?, highlights),
               notes = COALESCE(?, notes),
               metrics_json = COALESCE(?, metrics_json),
               github_commits_json = COALESCE(?, github_commits_json),
               status = COALESCE(?, status),
               error = ?,
               updated_at = datetime('now')
         WHERE date = ?
      `).run(
        summary ?? null,
        workContent ?? null,
        Number.isFinite(workMinutes) ? Math.round(workMinutes) : null,
        highlights ?? null,
        notes ?? null,
        metrics ? JSON.stringify(metrics) : null,
        githubCommits ? JSON.stringify(githubCommits) : null,
        status ?? null,
        error ?? null,
        date,
      );
    } else {
      db.prepare(`
        INSERT INTO diary_entries
          (date, summary, work_content, work_minutes, highlights, notes, metrics_json, github_commits_json, status, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        date,
        summary ?? null,
        workContent ?? null,
        Number.isFinite(workMinutes) ? Math.round(workMinutes) : null,
        highlights ?? null,
        notes ?? null,
        metrics ? JSON.stringify(metrics) : null,
        githubCommits ? JSON.stringify(githubCommits) : null,
        status ?? 'pending',
        error ?? null,
      );
    }
  });
  tx();
}

// ── weekly reports ---------------------------------------------------------

export function getWeekly(db, weekStart) {
  const row = db.prepare(`SELECT * FROM weekly_reports WHERE week_start = ?`).get(weekStart);
  if (!row) return null;
  return { ...row, github_summary: row.github_summary_json ? safeParse(row.github_summary_json) : null };
}

export function listWeeklyForMonth(db, monthStr) {
  return db.prepare(`
    SELECT week_start, week_end, week_in_month, status, summary, updated_at
    FROM weekly_reports
    WHERE month = ?
    ORDER BY week_start ASC
  `).all(monthStr);
}

export function upsertWeekly(db, { weekStart, weekEnd, month, weekInMonth, summary, githubSummary, status, error }) {
  const exists = db.prepare(`SELECT week_start FROM weekly_reports WHERE week_start = ?`).get(weekStart);
  if (exists) {
    db.prepare(`
      UPDATE weekly_reports
         SET week_end = COALESCE(?, week_end),
             month = COALESCE(?, month),
             week_in_month = COALESCE(?, week_in_month),
             summary = COALESCE(?, summary),
             github_summary_json = COALESCE(?, github_summary_json),
             status = COALESCE(?, status),
             error = ?,
             updated_at = datetime('now')
       WHERE week_start = ?
    `).run(
      weekEnd ?? null,
      month ?? null,
      weekInMonth ?? null,
      summary ?? null,
      githubSummary ? JSON.stringify(githubSummary) : null,
      status ?? null,
      error ?? null,
      weekStart,
    );
  } else {
    db.prepare(`
      INSERT INTO weekly_reports
        (week_start, week_end, month, week_in_month, summary, github_summary_json, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      weekStart,
      weekEnd,
      month,
      weekInMonth,
      summary ?? null,
      githubSummary ? JSON.stringify(githubSummary) : null,
      status ?? 'pending',
      error ?? null,
    );
  }
}

export function deleteWeekly(db, weekStart) {
  db.prepare(`DELETE FROM weekly_reports WHERE week_start = ?`).run(weekStart);
}

export function updateDiaryNotes(db, dateStr, notes) {
  db.prepare(`
    UPDATE diary_entries SET notes = ?, updated_at = datetime('now')
    WHERE date = ?
  `).run(notes ?? '', dateStr);
}

export function deleteDiary(db, dateStr) {
  db.prepare(`DELETE FROM diary_entries WHERE date = ?`).run(dateStr);
}

export function getDiarySettings(db) {
  const rows = db.prepare(`SELECT key, value FROM diary_settings`).all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setDiarySettings(db, patch) {
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') {
        db.prepare(`DELETE FROM diary_settings WHERE key = ?`).run(k);
      } else {
        db.prepare(`
          INSERT INTO diary_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(k, String(v));
      }
    }
  });
  tx();
}

/**
 * Top domains across the page_visits log (URL-only history),
 * regardless of whether the URL is bookmarked.
 */
export function trendsVisitDomains(db, { sinceDays = 30, limit = 12 } = {}) {
  const rows = db.prepare(`
    SELECT v.url, v.visit_count, v.last_seen_at
    FROM page_visits v
    WHERE v.last_seen_at >= datetime('now', ?)
  `).all(`-${Number(sinceDays) || 30} days`);
  const tally = new Map();
  for (const r of rows) {
    const d = extractDomain(r.url);
    if (!d) continue;
    const cur = tally.get(d) || { domain: d, visits: 0, urls: 0, last_seen_at: '' };
    cur.visits += r.visit_count || 1;
    cur.urls += 1;
    if (!cur.last_seen_at || r.last_seen_at > cur.last_seen_at) cur.last_seen_at = r.last_seen_at;
    tally.set(d, cur);
  }
  return [...tally.values()]
    .sort((a, b) => b.visits - a.visits || b.urls - a.urls)
    .slice(0, Number(limit) || 12);
}

// ── trends -----------------------------------------------------------------

/** Top categories by save count within `sinceDays`. */
export function trendsCategories(db, { sinceDays = 30, limit = 12 } = {}) {
  return db.prepare(`
    SELECT bc.category, COUNT(*) AS count
    FROM bookmark_categories bc
    JOIN bookmarks b ON b.id = bc.bookmark_id
    WHERE b.created_at >= datetime('now', ?)
    GROUP BY bc.category
    ORDER BY count DESC
    LIMIT ?
  `).all(`-${Number(sinceDays) || 30} days`, Number(limit) || 12);
}

/**
 * Compare category counts in the current window with the previous window of
 * the same length. Returns categories with the largest absolute delta.
 */
export function trendsCategoryDiff(db, { sinceDays = 7, limit = 8 } = {}) {
  const days = Number(sinceDays) || 7;
  const cur = db.prepare(`
    SELECT bc.category, COUNT(*) AS n
    FROM bookmark_categories bc
    JOIN bookmarks b ON b.id = bc.bookmark_id
    WHERE b.created_at >= datetime('now', ?)
    GROUP BY bc.category
  `).all(`-${days} days`);
  const prev = db.prepare(`
    SELECT bc.category, COUNT(*) AS n
    FROM bookmark_categories bc
    JOIN bookmarks b ON b.id = bc.bookmark_id
    WHERE b.created_at < datetime('now', ?)
      AND b.created_at >= datetime('now', ?)
    GROUP BY bc.category
  `).all(`-${days} days`, `-${days * 2} days`);
  const map = new Map();
  for (const r of cur) map.set(r.category, { current: r.n, previous: 0 });
  for (const r of prev) {
    const cur = map.get(r.category) || { current: 0, previous: 0 };
    cur.previous = r.n;
    map.set(r.category, cur);
  }
  const rows = [...map.entries()].map(([category, v]) => ({
    category,
    current: v.current,
    previous: v.previous,
    delta: v.current - v.previous,
  }));
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.current - a.current);
  return rows.slice(0, Number(limit) || 8);
}

/** Daily save and access counts (per day, local time) in the window. */
export function trendsTimeline(db, { sinceDays = 30 } = {}) {
  const days = Number(sinceDays) || 30;
  const saves = db.prepare(`
    SELECT date(created_at, 'localtime') AS d, COUNT(*) AS n
    FROM bookmarks
    WHERE created_at >= datetime('now', ?)
    GROUP BY d ORDER BY d ASC
  `).all(`-${days} days`);
  const accesses = db.prepare(`
    SELECT date(accessed_at, 'localtime') AS d, COUNT(*) AS n
    FROM accesses
    WHERE accessed_at >= datetime('now', ?)
    GROUP BY d ORDER BY d ASC
  `).all(`-${days} days`);
  // Build per-day series including zero-fill.
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({
      date: local,
      saves: saves.find(r => r.d === local)?.n ?? 0,
      accesses: accesses.find(r => r.d === local)?.n ?? 0,
    });
  }
  return out;
}

/** Top accessed domains in window. Joins accesses with bookmarks to get URLs. */
export function trendsDomains(db, { sinceDays = 30, limit = 12 } = {}) {
  const rows = db.prepare(`
    SELECT b.url, COUNT(a.id) AS hits
    FROM accesses a
    JOIN bookmarks b ON b.id = a.bookmark_id
    WHERE a.accessed_at >= datetime('now', ?)
    GROUP BY b.id
  `).all(`-${Number(sinceDays) || 30} days`);
  const tally = new Map();
  for (const r of rows) {
    const d = extractDomain(r.url);
    if (!d) continue;
    tally.set(d, (tally.get(d) ?? 0) + r.hits);
  }
  return [...tally.entries()]
    .map(([domain, hits]) => ({ domain, hits }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, Number(limit) || 12);
}

/**
 * Per-day estimated work minutes — sourced from `diary_entries.work_minutes`,
 * which is filled by Sonnet (`diary_work` task) when reading the day's URL
 * timeline. The previous algorithm derived sessions from visit_events alone
 * and over-counted days with long idle browser tabs (one open tab refreshing
 * itself for hours could push a single day past 24h).
 *
 * Days without a generated diary (or where Sonnet declined to estimate)
 * report `null` minutes — the chart skips them rather than misleading with 0.
 */
export function trendsWorkHours(db, { sinceDays = 30 } = {}) {
  const days = Number(sinceDays) || 30;
  function dateKeyLocal(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const rows = db.prepare(`
    SELECT date, work_minutes FROM diary_entries
    WHERE date >= ? AND work_minutes IS NOT NULL
  `).all(dateKeyLocal(new Date(Date.now() - (days - 1) * 86400_000)));
  const perDay = new Map();
  for (const r of rows) perDay.set(r.date, r.work_minutes);

  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const k = dateKeyLocal(dt);
    out.push({
      date: k,
      minutes: perDay.has(k) ? perDay.get(k) : null,
    });
  }
  return out;
}

/**
 * Per-day walking summary derived from `gps_locations` (OwnTracks 由来):
 *   - distance_km: 連続点の haversine 合計 (accuracy < 200m / Δt < 10min で
 *     ノイズフィルタ)
 *   - walking_minutes: 0.5〜3.5 m/s の区間 Δt 合計 (徒歩速度帯)
 *   - travel_minutes: 0.5 m/s 以上で動いていた区間 Δt 合計 (移動全体、
 *     乗り物含む)
 *
 * 静止判定は速度ベース。停車中の jitter は accuracy で弾く。
 */
export function trendsGpsWalking(db, { sinceDays = 30, userId = 'me' } = {}) {
  const days = Number(sinceDays) || 30;
  function dateKeyLocal(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function parseUtc(s) {
    return new Date(String(s).replace(' ', 'T') + 'Z');
  }
  function haversineMeters(a, b) {
    const R = 6_371_008;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const sa = Math.sin(dLat / 2);
    const so = Math.sin(dLon / 2);
    const h = sa * sa + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * so * so;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  const SEG_DT_MAX_MS = 10 * 60_000;       // > 10 分の隙間は信頼しない
  const ACC_MAX_M = 200;                   // accuracy 200m 超は jitter とみなす
  const WALK_MIN_MPS = 0.5;                // 1.8 km/h
  const WALK_MAX_MPS = 3.5;                // 12.6 km/h (上限 = ジョギング以下)
  const TRAVEL_MIN_MPS = 0.5;              // 動いている扱いの下限

  const startDate = new Date(Date.now() - (days - 1) * 86400_000);
  const startKey = dateKeyLocal(startDate);
  const rows = db.prepare(`
    SELECT recorded_at, lat, lon, accuracy_m
    FROM gps_locations
    WHERE user_id = ? AND date(recorded_at, 'localtime') >= ?
    ORDER BY recorded_at ASC
  `).all(userId, startKey);

  const perDay = new Map();
  function bucket(key) {
    let b = perDay.get(key);
    if (!b) {
      b = { distance_m: 0, walking_ms: 0, travel_ms: 0 };
      perDay.set(key, b);
    }
    return b;
  }
  let prev = null;
  for (const r of rows) {
    const d = parseUtc(r.recorded_at);
    const ts = d.getTime();
    if (!Number.isFinite(ts)) { prev = null; continue; }
    const key = dateKeyLocal(d);
    const accOk = !r.accuracy_m || r.accuracy_m < ACC_MAX_M;
    if (prev && prev.key === key && accOk && prev.accOk) {
      const dt = ts - prev.ts;
      if (dt > 0 && dt <= SEG_DT_MAX_MS) {
        const dist = haversineMeters(prev, { lat: r.lat, lon: r.lon });
        const speed = dist / (dt / 1000); // m/s
        const b = bucket(key);
        b.distance_m += dist;
        if (speed >= TRAVEL_MIN_MPS) b.travel_ms += dt;
        if (speed >= WALK_MIN_MPS && speed <= WALK_MAX_MPS) b.walking_ms += dt;
      }
    }
    prev = { ts, key, lat: r.lat, lon: r.lon, accOk };
  }

  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const k = dateKeyLocal(dt);
    const b = perDay.get(k);
    out.push({
      date: k,
      distance_km: b ? Number((b.distance_m / 1000).toFixed(2)) : 0,
      walking_minutes: b ? Math.round(b.walking_ms / 60_000) : 0,
      travel_minutes: b ? Math.round(b.travel_ms / 60_000) : 0,
    });
  }
  return out;
}

const KEYWORD_STOPWORDS = new Set([
  'the','and','for','with','from','that','this','your','you','our','have','has','was','were','will','what','when','where','which','who','about','into','than','then','also','but','not','are','can','use','using','how','why','etc',
  'について','として','による','によって','などの','する','して','です','ます','ない','ある','こと','もの','よう','これ','それ','ため','など','とは','では','での','さん','さま','様','記事','ページ','こちら','そして','しかし','ただし','ここ','以下','以上',
]);

function tokenize(text) {
  const t = String(text || '').toLowerCase();
  const out = [];
  // ASCII / Latin words ≥ 3 chars.
  for (const m of t.matchAll(/[a-z][a-z0-9_+#.-]{2,}/g)) out.push(m[0]);
  // Japanese-ish runs ≥ 2 chars (CJK + katakana/hiragana lump).
  for (const m of t.matchAll(/[぀-ヿ一-鿿]{2,}/g)) out.push(m[0]);
  return out.filter(w => !KEYWORD_STOPWORDS.has(w));
}

/**
 * Keyword frequency across recent page titles + bookmark titles + dig
 * queries. Crude tokeniser: ASCII words ≥3 chars + JP runs ≥2 chars,
 * minus stopwords.
 */
export function trendsKeywords(db, { sinceDays = 30, limit = 25 } = {}) {
  const days = Number(sinceDays) || 30;
  const ago = `-${days} days`;
  const sources = [];
  for (const r of db.prepare(`
    SELECT title FROM page_visits WHERE last_seen_at >= datetime('now', ?)
  `).all(ago)) sources.push(r.title);
  for (const r of db.prepare(`
    SELECT title FROM bookmarks WHERE created_at >= datetime('now', ?)
  `).all(ago)) sources.push(r.title);
  for (const r of db.prepare(`
    SELECT query FROM dig_sessions WHERE created_at >= datetime('now', ?)
  `).all(ago)) sources.push(r.query);
  // Dictionary terms also reflect what the user is studying.
  for (const r of db.prepare(`
    SELECT term FROM dictionary_entries WHERE updated_at >= datetime('now', ?)
  `).all(ago)) sources.push(r.term);

  const tally = new Map();
  for (const text of sources) {
    if (!text) continue;
    const seen = new Set();  // count each source once per word
    for (const w of tokenize(text)) {
      if (seen.has(w)) continue;
      seen.add(w);
      tally.set(w, (tally.get(w) || 0) + 1);
    }
  }
  return [...tally.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Number(limit) || 25);
}

function extractDomain(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}
function firstPathSegment(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    return segs[0] || null;
  } catch { return null; }
}

export function recordAccess(db, bookmarkId) {
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO accesses (bookmark_id) VALUES (?)`).run(bookmarkId);
    db.prepare(`
      UPDATE bookmarks
      SET last_accessed_at = datetime('now'),
          access_count    = access_count + 1
      WHERE id = ?
    `).run(bookmarkId);
  });
  tx();
}

export function listAccesses(db, bookmarkId, limit = 50) {
  return db.prepare(`
    SELECT id, accessed_at FROM accesses
    WHERE bookmark_id = ? ORDER BY accessed_at DESC LIMIT ?
  `).all(bookmarkId, limit);
}

export function deleteBookmark(db, id) {
  const row = db.prepare(`SELECT html_path FROM bookmarks WHERE id = ?`).get(id);
  db.prepare(`DELETE FROM bookmarks WHERE id = ?`).run(id);
  return row?.html_path ?? null;
}

/** Insert a bookmark from an export bundle. Skips if URL already exists. */
export function insertImportedBookmark(db, b) {
  const existing = findBookmarkByUrl(db, b.url);
  if (existing) return { skipped: true, id: existing.id };
  const info = db.prepare(`
    INSERT INTO bookmarks (url, title, html_path, summary, memo, status, created_at, updated_at, last_accessed_at, access_count)
    VALUES (?, ?, ?, ?, ?, 'done', COALESCE(?, datetime('now')), datetime('now'), ?, ?)
  `).run(
    b.url,
    b.title ?? '',
    b.html_path ?? '',
    b.summary ?? null,
    b.memo ?? '',
    b.created_at ?? null,
    b.last_accessed_at ?? null,
    b.access_count ?? 0,
  );
  const id = info.lastInsertRowid;
  if (Array.isArray(b.categories)) {
    const ins = db.prepare(`INSERT OR IGNORE INTO bookmark_categories (bookmark_id, category) VALUES (?, ?)`);
    for (const cat of b.categories) {
      const trimmed = String(cat).trim();
      if (trimmed) ins.run(id, trimmed);
    }
  }
  return { skipped: false, id };
}

// ---------------------------------------------------------------------------
// gps_locations — OwnTracks 由来の位置情報
// ---------------------------------------------------------------------------

const GPS_INSERT_STMT_KEY = Symbol('gpsInsertStmt');

/**
 * 1 点の GPS 位置を挿入する。同一 (user_id, device_id, recorded_at) は無視 (重複防止)。
 * `loc.recordedAt` は ISO 8601、`loc.tst` (OwnTracks の epoch 秒) どちらか必須。
 */
export function insertGpsLocation(db, loc) {
  const userId = loc.userId || 'me';
  const recordedAt = loc.recordedAt
    ? loc.recordedAt
    : (typeof loc.tst === 'number'
        ? new Date(loc.tst * 1000).toISOString()
        : new Date().toISOString());
  // CONFLICT 回避: 同一 (user, device, time) の点は dedup
  const dupCheck = db.prepare(`
    SELECT id FROM gps_locations
    WHERE user_id = ? AND IFNULL(device_id, '') = IFNULL(?, '') AND recorded_at = ?
    LIMIT 1
  `).get(userId, loc.deviceId ?? null, recordedAt);
  if (dupCheck) return { skipped: true, id: dupCheck.id };

  const info = db.prepare(`
    INSERT INTO gps_locations
      (user_id, device_id, recorded_at, lat, lon,
       accuracy_m, altitude_m, velocity_kmh, course_deg, battery_pct, conn, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    loc.deviceId ?? null,
    recordedAt,
    loc.lat,
    loc.lon,
    loc.accuracy ?? null,
    loc.altitude ?? null,
    loc.velocity ?? null,
    loc.course ?? null,
    loc.battery ?? null,
    loc.conn ?? null,
    loc.rawJson ?? null,
  );
  return { skipped: false, id: info.lastInsertRowid };
}

/**
 * 期間内の位置点を時系列順で返す。`from` / `to` は ISO 8601。
 * device_id を絞り込みたい場合は `deviceId` を渡す。
 */
export function listGpsLocationsInRange(db, { from, to, userId = 'me', deviceId } = {}) {
  const where = ['user_id = ?'];
  const params = [userId];
  if (from) { where.push('recorded_at >= ?'); params.push(from); }
  if (to)   { where.push('recorded_at <= ?'); params.push(to); }
  if (deviceId) { where.push('device_id = ?'); params.push(deviceId); }
  return db.prepare(`
    SELECT id, user_id, device_id, recorded_at, lat, lon,
           accuracy_m, altitude_m, velocity_kmh, course_deg, battery_pct, conn
    FROM gps_locations
    WHERE ${where.join(' AND ')}
    ORDER BY recorded_at ASC
  `).all(...params);
}

/**
 * 位置情報を持っている日付 (YYYY-MM-DD, local TZ) と件数を新しい順で返す。
 * UI の date picker / カレンダー表示用。
 */
export function listGpsLocationDays(db, { userId = 'me', limit = 365 } = {}) {
  return db.prepare(`
    SELECT date(recorded_at, 'localtime') AS day,
           COUNT(*)                       AS points,
           MIN(recorded_at)               AS first_at,
           MAX(recorded_at)               AS last_at
    FROM gps_locations
    WHERE user_id = ?
    GROUP BY day
    ORDER BY day DESC
    LIMIT ?
  `).all(userId, limit);
}

/**
 * 当日 (local TZ) の点件数。日記 / metrics 用の安価な取得。
 */
export function gpsLocationCountForDate(db, dateStr, { userId = 'me' } = {}) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM gps_locations
    WHERE user_id = ? AND date(recorded_at, 'localtime') = ?
  `).get(userId, dateStr);
  return row ? row.n : 0;
}

/**
 * 指定日 (local TZ) の点を時系列で返す。日記の metrics + Maps overlay 共用。
 */
export function listGpsLocationsForDate(db, dateStr, { userId = 'me' } = {}) {
  return db.prepare(`
    SELECT id, device_id, recorded_at, lat, lon,
           accuracy_m, altitude_m, velocity_kmh, course_deg
    FROM gps_locations
    WHERE user_id = ? AND date(recorded_at, 'localtime') = ?
    ORDER BY recorded_at ASC
  `).all(userId, dateStr);
}

/**
 * 古い点を削除する (retention)。`olderThan` は ISO 8601。
 */
export function deleteGpsLocationsOlderThan(db, olderThan, { userId = 'me' } = {}) {
  const info = db.prepare(`
    DELETE FROM gps_locations
    WHERE user_id = ? AND recorded_at < ?
  `).run(userId, olderThan);
  return info.changes;
}

void GPS_INSERT_STMT_KEY; // reserved for prepared-stmt cache

// ─── meals ────────────────────────────────────────────────

/** Find the GPS point closest to `at` (ISO8601), within `windowMs`. */
export function findNearestGpsLocation(db, at, { windowMs = 5 * 60 * 1000, userId = 'me' } = {}) {
  const center = new Date(at);
  if (isNaN(center.getTime())) return null;
  const from = new Date(center.getTime() - windowMs).toISOString();
  const to = new Date(center.getTime() + windowMs).toISOString();
  const rows = db.prepare(`
    SELECT id, recorded_at, lat, lon, accuracy_m
    FROM gps_locations
    WHERE user_id = ? AND recorded_at BETWEEN ? AND ?
    ORDER BY recorded_at
  `).all(userId, from, to);
  if (rows.length === 0) return null;
  let best = rows[0];
  let bestDiff = Math.abs(new Date(best.recorded_at).getTime() - center.getTime());
  for (const r of rows.slice(1)) {
    const d = Math.abs(new Date(r.recorded_at).getTime() - center.getTime());
    if (d < bestDiff) {
      bestDiff = d;
      best = r;
    }
  }
  return best;
}

export function insertMeal(db, m) {
  const info = db.prepare(`
    INSERT INTO meals (
      photo_path, eaten_at, eaten_at_source,
      lat, lon, location_label, location_source,
      description, calories, items_json,
      ai_status, ai_error, user_note,
      user_corrected_description, user_corrected_calories
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.photo_path, m.eaten_at, m.eaten_at_source ?? 'manual',
    m.lat ?? null, m.lon ?? null, m.location_label ?? null, m.location_source ?? null,
    m.description ?? null, m.calories ?? null, m.items_json ?? null,
    m.ai_status ?? 'pending', m.ai_error ?? null, m.user_note ?? null,
    m.user_corrected_description ?? null, m.user_corrected_calories ?? null,
  );
  return Number(info.lastInsertRowid);
}

export function getMeal(db, id) {
  return db.prepare(`SELECT * FROM meals WHERE id = ?`).get(id);
}

export function listMeals(db, { from, to, limit = 100, offset = 0 } = {}) {
  const where = [];
  const args = [];
  if (from) { where.push(`eaten_at >= ?`); args.push(from); }
  if (to)   { where.push(`eaten_at <= ?`); args.push(to);   }
  const sql = `
    SELECT * FROM meals
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY eaten_at DESC
    LIMIT ? OFFSET ?
  `;
  args.push(limit, offset);
  return db.prepare(sql).all(...args);
}

export function countMeals(db, { from, to } = {}) {
  const where = [];
  const args = [];
  if (from) { where.push(`eaten_at >= ?`); args.push(from); }
  if (to)   { where.push(`eaten_at <= ?`); args.push(to);   }
  const sql = `SELECT COUNT(*) AS c FROM meals ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  return db.prepare(sql).get(...args).c;
}

export function updateMeal(db, id, patch) {
  const cols = [];
  const args = [];
  for (const [k, v] of Object.entries(patch)) {
    cols.push(`${k} = ?`);
    args.push(v);
  }
  if (cols.length === 0) return;
  cols.push(`updated_at = datetime('now')`);
  args.push(id);
  db.prepare(`UPDATE meals SET ${cols.join(', ')} WHERE id = ?`).run(...args);
}

export function deleteMeal(db, id) {
  db.prepare(`DELETE FROM meals WHERE id = ?`).run(id);
}

export function listPendingMeals(db, { limit = 20 } = {}) {
  return db.prepare(`
    SELECT * FROM meals WHERE ai_status = 'pending'
    ORDER BY id ASC LIMIT ?
  `).all(limit);
}

/** 指定日 (ローカル YYYY-MM-DD) の食事を eaten_at 昇順で返す。 */
export function listMealsForDate(db, dateStr) {
  return db.prepare(`
    SELECT * FROM meals
    WHERE date(eaten_at, 'localtime') = ?
    ORDER BY eaten_at ASC
  `).all(dateStr);
}

// ─── user stopwords (ユーザカスタムの語彙除外) ─────────────────
//
// dig graph / wordcloud などで「もう出さなくていい」 単語を蓄積する。
// 表示側 (app.js) で随時 filter するのと、 サーバ抽出側で除外するのと
// 両方で参照する想定 (今は表示側 filter のみで運用)。

export function ensureUserStopwordsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_stopwords (
      word        TEXT PRIMARY KEY,
      lower       TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_user_stopwords_lower ON user_stopwords(lower);
  `);
}

export function listUserStopwords(db) {
  return db.prepare(`SELECT word, lower, created_at FROM user_stopwords ORDER BY created_at DESC`).all();
}

export function addUserStopword(db, word) {
  const w = String(word ?? '').trim();
  if (!w) return false;
  db.prepare(`INSERT OR IGNORE INTO user_stopwords (word, lower) VALUES (?, ?)`).run(w, w.toLowerCase());
  return true;
}

export function removeUserStopword(db, word) {
  const w = String(word ?? '').trim();
  if (!w) return false;
  const info = db.prepare(`DELETE FROM user_stopwords WHERE lower = ?`).run(w.toLowerCase());
  return info.changes > 0;
}

