import { safeParse } from './_helpers.js';

// ── diary -----------------------------------------------------------------

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
