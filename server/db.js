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
      result_json   TEXT
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

    CREATE TABLE IF NOT EXISTS chunks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      bookmark_id  INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      idx          INTEGER NOT NULL,
      text         TEXT NOT NULL,
      vec          BLOB NOT NULL,
      vec_dim      INTEGER NOT NULL,
      vec_model    TEXT NOT NULL DEFAULT 'multilingual-e5-small'
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_bookmark ON chunks(bookmark_id);
  `);

  // Forward-compat: ensure newer columns exist on older DBs.
  const cols = db.prepare(`PRAGMA table_info(bookmarks)`).all().map(c => c.name);
  if (!cols.includes('last_accessed_at')) {
    db.exec(`ALTER TABLE bookmarks ADD COLUMN last_accessed_at TEXT`);
  }
  if (!cols.includes('access_count')) {
    db.exec(`ALTER TABLE bookmarks ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.includes('user_id')) {
    db.exec(`ALTER TABLE bookmarks ADD COLUMN user_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id)`);
  }

  // page_visits also needs user_id for proper online-mode isolation.
  const visitCols = db.prepare(`PRAGMA table_info(page_visits)`).all().map(c => c.name);
  if (!visitCols.includes('user_id')) {
    db.exec(`ALTER TABLE page_visits ADD COLUMN user_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_visits_user ON page_visits(user_id)`);
  }

  return db;
}

/** Build the WHERE fragment + binding for user scoping. Pass null for local mode. */
function userClause(userId, alias = 'b') {
  if (userId == null) return { where: '', args: [] };
  return { where: ` AND ${alias}.user_id = ?`, args: [userId] };
}

export function listBookmarks(db, { category, sort = 'created_desc', userId = null } = {}) {
  const orderClauses = {
    created_desc: 'b.created_at DESC',
    created_asc: 'b.created_at ASC',
    accessed_desc: 'COALESCE(b.last_accessed_at, b.created_at) DESC',
    accessed_asc: 'COALESCE(b.last_accessed_at, b.created_at) ASC',
    title_asc: 'b.title ASC',
  };
  const orderBy = orderClauses[sort] ?? orderClauses.created_desc;
  const u = userClause(userId);
  let rows;
  if (category) {
    rows = db.prepare(`
      SELECT b.* FROM bookmarks b
      JOIN bookmark_categories bc ON bc.bookmark_id = b.id
      WHERE bc.category = ?${u.where}
      ORDER BY ${orderBy}
    `).all(category, ...u.args);
  } else {
    rows = db.prepare(`
      SELECT b.* FROM bookmarks b
      WHERE 1=1${u.where}
      ORDER BY ${orderBy}
    `).all(...u.args);
  }
  return rows.map(r => ({ ...r, categories: getCategories(db, r.id) }));
}

export function getBookmark(db, id, { userId = null } = {}) {
  const row = db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).get(id);
  if (!row) return null;
  if (userId != null && row.user_id !== userId) return null;
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

export function insertBookmark(db, { url, title, htmlPath, userId = null }) {
  const stmt = db.prepare(`
    INSERT INTO bookmarks (url, title, html_path, user_id) VALUES (?, ?, ?, ?)
  `);
  const info = stmt.run(url, title, htmlPath, userId);
  return info.lastInsertRowid;
}

export function findBookmarkByUrl(db, url, { userId = null } = {}) {
  if (userId != null) {
    return db.prepare(
      `SELECT * FROM bookmarks WHERE url = ? AND user_id = ? ORDER BY id DESC LIMIT 1`
    ).get(url, userId) ?? null;
  }
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
export function upsertVisit(db, { url, title, userId = null }) {
  db.prepare(`
    INSERT INTO page_visits (url, title, user_id)
    VALUES (?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      title = COALESCE(NULLIF(excluded.title, ''), page_visits.title),
      last_seen_at = datetime('now'),
      visit_count = page_visits.visit_count + 1
  `).run(url, title ?? null, userId);
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

export function insertDigSession(db, query) {
  return db.prepare(`INSERT INTO dig_sessions (query) VALUES (?)`).run(query).lastInsertRowid;
}

export function setDigResult(db, id, { status, result, error }) {
  db.prepare(`
    UPDATE dig_sessions SET status = ?, result_json = ?, error = ?
    WHERE id = ?
  `).run(status, result ? JSON.stringify(result) : null, error ?? null, id);
}

export function getDigSession(db, id) {
  const row = db.prepare(`SELECT * FROM dig_sessions WHERE id = ?`).get(id);
  if (!row) return null;
  return {
    ...row,
    result: row.result_json ? safeParse(row.result_json) : null,
  };
}

export function listDigSessions(db, limit = 30) {
  return db.prepare(`
    SELECT id, query, status, created_at FROM dig_sessions
    ORDER BY id DESC LIMIT ?
  `).all(limit);
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

// ── chunks / embeddings ----------------------------------------------------

export function deleteChunks(db, bookmarkId) {
  db.prepare(`DELETE FROM chunks WHERE bookmark_id = ?`).run(bookmarkId);
}

export function insertChunk(db, { bookmarkId, idx, text, vec, model }) {
  db.prepare(`
    INSERT INTO chunks (bookmark_id, idx, text, vec, vec_dim, vec_model)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(bookmarkId, idx, text, vec, vec.length / 4, model || 'multilingual-e5-small');
}

export function listChunkRows(db) {
  return db.prepare(`SELECT id, bookmark_id, idx, text, vec FROM chunks`).all();
}

export function bookmarksMissingEmbeddings(db) {
  return db.prepare(`
    SELECT b.id FROM bookmarks b
    LEFT JOIN chunks c ON c.bookmark_id = b.id
    WHERE c.id IS NULL AND b.status = 'done'
    ORDER BY b.created_at DESC
  `).all().map(r => r.id);
}

export function chunkStats(db) {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get().n;
  const docs = db.prepare(`SELECT COUNT(DISTINCT bookmark_id) AS n FROM chunks`).get().n;
  return { total_chunks: total, indexed_bookmarks: docs };
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
