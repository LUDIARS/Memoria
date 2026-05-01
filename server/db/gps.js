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
