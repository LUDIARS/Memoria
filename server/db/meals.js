// ─── meals ────────────────────────────────────────────────

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
