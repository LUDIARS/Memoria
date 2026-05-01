import { safeParse } from './_helpers.js';

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
