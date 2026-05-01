// ---------------------------------------------------------------------------
// gps_locations — OwnTracks 由来の位置情報
// ---------------------------------------------------------------------------

const GPS_INSERT_STMT_KEY = Symbol('gpsInsertStmt');

/** 停止区間判定の距離閾値 (メートル)。 */
export const GPS_STATIONARY_THRESHOLD_M = 50;

function gpsHaversine(a, b) {
  const R = 6_371_008;
  const t = (d) => (d * Math.PI) / 180;
  const dLat = t(b.lat - a.lat);
  const dLon = t(b.lon - a.lon);
  const sa = Math.sin(dLat / 2);
  const so = Math.sin(dLon / 2);
  const h = sa * sa + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * so * so;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

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

  // 圧縮判定: 直近 2 行を確認
  const recent = db.prepare(`
    SELECT id, lat, lon, recorded_at, samples_count, samples_first_at
    FROM gps_locations
    WHERE user_id = ? AND IFNULL(device_id, '') = IFNULL(?, '')
    ORDER BY recorded_at DESC
    LIMIT 2
  `).all(userId, loc.deviceId ?? null);

  if (recent.length === 2) {
    const LAST = recent[0];
    const PREV = recent[1];
    const N = { lat: loc.lat, lon: loc.lon };
    const T = GPS_STATIONARY_THRESHOLD_M;
    if (
      gpsHaversine(PREV, LAST) < T &&
      gpsHaversine(PREV, N) < T &&
      gpsHaversine(LAST, N) < T
    ) {
      const samplesFirstAt = LAST.samples_first_at || LAST.recorded_at;
      db.prepare(`
        UPDATE gps_locations
        SET recorded_at = ?, lat = ?, lon = ?,
            accuracy_m = ?, altitude_m = ?, velocity_kmh = ?, course_deg = ?,
            battery_pct = ?, conn = ?, raw_json = ?,
            samples_count = samples_count + 1,
            samples_first_at = COALESCE(samples_first_at, ?)
        WHERE id = ?
      `).run(
        recordedAt, loc.lat, loc.lon,
        loc.accuracy ?? null, loc.altitude ?? null, loc.velocity ?? null, loc.course ?? null,
        loc.battery ?? null, loc.conn ?? null, loc.rawJson ?? null,
        samplesFirstAt, LAST.id,
      );
      return { merged: true, id: LAST.id };
    }
  }

  const info = db.prepare(`
    INSERT INTO gps_locations
      (user_id, device_id, recorded_at, lat, lon,
       accuracy_m, altitude_m, velocity_kmh, course_deg, battery_pct, conn, raw_json,
       samples_count, samples_first_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
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
  return { inserted: true, id: info.lastInsertRowid };
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
           accuracy_m, altitude_m, velocity_kmh, course_deg, battery_pct, conn,
           samples_count, samples_first_at
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
           accuracy_m, altitude_m, velocity_kmh, course_deg,
           samples_count, samples_first_at
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

/**
 * 既存 GPS データに対して停止区間圧縮を遡及適用する。
 * 戻り値: { devices, total_deleted, total_segments, total_kept }
 */
export function compressGpsHistory(db, { userId = 'me', deviceId = null, threshold = GPS_STATIONARY_THRESHOLD_M } = {}) {
  const T = threshold;
  const deviceRows = deviceId
    ? [{ device_id: deviceId }]
    : db.prepare(`SELECT DISTINCT device_id FROM gps_locations WHERE user_id = ?`).all(userId);

  const summary = { devices: [], total_deleted: 0, total_segments: 0, total_kept: 0 };

  for (const { device_id } of deviceRows) {
    const rows = db.prepare(`
      SELECT id, recorded_at, lat, lon, samples_count, samples_first_at
      FROM gps_locations
      WHERE user_id = ? AND IFNULL(device_id, '') = IFNULL(?, '')
      ORDER BY recorded_at ASC
    `).all(userId, device_id);

    const before = rows.length;
    if (rows.length < 3) {
      summary.devices.push({ device_id, before, after: before, deleted: 0, segments: rows.length > 0 ? 1 : 0 });
      summary.total_kept += before;
      continue;
    }

    let deleted = 0;
    let segments = 0;

    const tx = db.transaction(() => {
      let i = 0;
      while (i < rows.length) {
        const anchor = rows[i];
        let j = i + 1;
        while (
          j < rows.length &&
          gpsHaversine(anchor, rows[j]) < T &&
          gpsHaversine(rows[j - 1], rows[j]) < T
        ) {
          j++;
        }
        const clusterSize = j - i;
        segments++;
        if (clusterSize > 2) {
          const tail = rows[j - 1];
          const middleIds = rows.slice(i + 1, j - 1).map((r) => r.id);
          const tailNewSamples = rows.slice(i + 1, j).reduce((s, r) => s + (r.samples_count || 1), 0);
          const samplesFirstAt = rows[i + 1].samples_first_at || rows[i + 1].recorded_at;
          const delStmt = db.prepare(`DELETE FROM gps_locations WHERE id = ?`);
          for (const id of middleIds) delStmt.run(id);
          db.prepare(`
            UPDATE gps_locations SET samples_count = ?, samples_first_at = ? WHERE id = ?
          `).run(tailNewSamples, samplesFirstAt, tail.id);
          deleted += middleIds.length;
        }
        i = j;
      }
    });
    tx();

    summary.devices.push({ device_id, before, after: before - deleted, deleted, segments });
    summary.total_deleted += deleted;
    summary.total_segments += segments;
    summary.total_kept += before - deleted;
  }

  return summary;
}

// ── 位置照合 (place name/address) ──────────────────────────────────────────

/** 近接 (約 gridM 以内) で既に解決済の点を 1 件返す。 */
export function findNearbyResolvedPlace(db, lat, lon, gridM = 10) {
  const dLat = gridM / 111_320;
  const dLon = gridM / (111_320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return db.prepare(`
    SELECT place_name, place_address, place_source
      FROM gps_locations
     WHERE place_resolved_at IS NOT NULL
       AND place_source IN ('places', 'geocode', 'cached')
       AND lat BETWEEN ? AND ?
       AND lon BETWEEN ? AND ?
     ORDER BY place_resolved_at DESC
     LIMIT 1
  `).get(lat - dLat, lat + dLat, lon - dLon, lon + dLon) ?? null;
}

/** id の行に place 結果を書き込む。 */
export function setGpsPlace(db, id, { name, address, source }) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE gps_locations
       SET place_name = ?, place_address = ?, place_source = ?, place_resolved_at = ?
     WHERE id = ?
  `).run(name ?? null, address ?? null, source ?? 'failed', now, id);
}

/** 未解決の点 (place_resolved_at IS NULL) を新しい順に N 件返す。 */
export function listUnresolvedGpsLocations(db, limit = 50) {
  return db.prepare(`
    SELECT id, lat, lon, recorded_at, device_id
      FROM gps_locations
     WHERE place_resolved_at IS NULL
     ORDER BY id DESC
     LIMIT ?
  `).all(limit);
}

/** 1 行を id 指定で読む。 */
export function findGpsLocationById(db, id) {
  return db.prepare(`SELECT id, lat, lon, place_resolved_at FROM gps_locations WHERE id = ?`).get(id) ?? null;
}

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
