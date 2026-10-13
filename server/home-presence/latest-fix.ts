// 最新 GPS の取得と鮮度判定。 GPS の取り込み口は複数あるので、 取り込み側に手を入れず最新行を読む。

import type BetterSqlite3 from 'better-sqlite3';
import type { GpsFix } from './types.js';

type Db = BetterSqlite3.Database;

/** 精度がこれより悪い点 (Wi-Fi 推定の粗い点など) は判定に使わない (m)。 */
export const MAX_ACCURACY_M = 300;

export function readLatestFix(db: Db): GpsFix | null {
  const row = db.prepare(`
    SELECT lat, lon, recorded_at FROM gps_locations
    WHERE user_id = 'me' AND (accuracy_m IS NULL OR accuracy_m <= ?)
    ORDER BY recorded_at DESC LIMIT 1
  `).get(MAX_ACCURACY_M) as { lat: number; lon: number; recorded_at: string } | undefined;
  if (!row) return null;
  const recordedAt = Date.parse(row.recorded_at);
  if (!Number.isFinite(recordedAt)) return null;
  return { lat: row.lat, lon: row.lon, recordedAt };
}

export function isFresh(fix: GpsFix, staleMin: number, now: number): boolean {
  return now - fix.recordedAt <= staleMin * 60_000;
}
