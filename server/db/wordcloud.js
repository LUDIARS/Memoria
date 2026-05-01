import { safeParse } from './_helpers.js';

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
