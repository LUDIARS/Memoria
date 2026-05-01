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
