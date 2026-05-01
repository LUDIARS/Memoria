// activity_events — git commit / Claude Code prompt 等の開発活動イベント

import { safeParse } from './_helpers.js';

const ACTIVITY_KINDS = new Set(['git_commit', 'claude_code_prompt']);

/**
 * 活動イベントを 1 件記録する。
 * kind+ref_id の重複は INSERT OR IGNORE で吸収。
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

/** 当日 (local) の活動イベントを時刻昇順で全件返す。 */
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

/** 直近 limit 件 (新しい順)。全期間 / 任意 kind フィルタつき。 */
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

/**
 * 当日 (local) の活動イベントを時刻降順でページング取得する。
 * 戻り値: { items, total, limit, offset }
 */
export function activityEventsPage(db, dateStr, { limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM activity_events
    WHERE date(occurred_at, 'localtime') = ?
  `).get(dateStr).n;
  const items = db.prepare(`
    SELECT id, kind, occurred_at, source, ref_id, content, metadata_json
    FROM activity_events
    WHERE date(occurred_at, 'localtime') = ?
    ORDER BY occurred_at DESC
    LIMIT ? OFFSET ?
  `).all(dateStr, safeLimit, safeOffset).map((r) => ({
    ...r,
    metadata: r.metadata_json ? safeParse(r.metadata_json) : null,
  }));
  return { items, total, limit: safeLimit, offset: safeOffset };
}
