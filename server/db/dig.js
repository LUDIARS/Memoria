import { safeParse } from './_helpers.js';

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
