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
