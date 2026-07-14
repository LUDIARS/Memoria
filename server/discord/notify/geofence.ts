// 自宅 geofence の inside 判定と 帰宅/出発 遷移検出。
// 自宅座標は weather.fixed_lat/lon (既存) を流用、 最新 GPS は readLatestGpsLatLon。
// 遷移状態は app_settings に持つ (process 再起動を跨いで誤発火しないため)。

import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../../db.js';
import { readLatestGpsLatLon } from '../../lib/weather.js';
import type { GpsEvent } from './types.js';

type Db = BetterSqlite3.Database;

const STATE_INSIDE = 'features.discord.notify.gps.inside';        // '1' | '0'
const STATE_LAST_TRANSITION = 'features.discord.notify.gps.last_transition_at'; // epoch ms
const COOLDOWN_MS = 10 * 60 * 1000; // 境界での GPS ジッタ抑制

export function haversineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 自宅座標 (weather.fixed_lat/lon)。 未設定 (0,0 含む) なら null。 */
export function homeLatLon(db: Db): { lat: number; lon: number } | null {
  const s = getAppSettings(db);
  const lat = Number(s['weather.fixed_lat']);
  const lon = Number(s['weather.fixed_lon']);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

/** いま自宅 geofence 内か。 自宅未設定 / GPS 無しなら null。 */
export function isInsideHome(db: Db, radiusM: number): boolean | null {
  const home = homeLatLon(db);
  if (!home) return null;
  const cur = readLatestGpsLatLon(db);
  if (!cur) return null;
  return haversineMeters(home, cur) <= radiusM;
}

/**
 * 前回状態と比較して帰宅 (arrive=外→内) / 出発 (depart=内→外) を検出。
 * - 初回 (状態未保存) は基準を保存して null (発火しない)。
 * - データ無し (自宅未設定 / GPS 無し) は null。
 * - cooldown 内の再遷移は無視 (境界ジッタ対策)。
 * 検出時は状態を更新する (副作用あり)。
 */
export function detectHomeTransition(db: Db, radiusM: number, now: number = Date.now()): GpsEvent | null {
  const inside = isInsideHome(db, radiusM);
  if (inside === null) return null;

  const s = getAppSettings(db);
  const prevRaw = s[STATE_INSIDE];
  const cur = inside ? '1' : '0';

  if (prevRaw !== '0' && prevRaw !== '1') {
    // 初回: 基準だけ保存
    setAppSettings(db, { [STATE_INSIDE]: cur });
    return null;
  }
  if (prevRaw === cur) return null; // 遷移なし

  const lastAt = Number(s[STATE_LAST_TRANSITION]);
  if (Number.isFinite(lastAt) && now - lastAt < COOLDOWN_MS) {
    // cooldown 内: 状態は更新するが発火しない (ジッタとみなす)
    setAppSettings(db, { [STATE_INSIDE]: cur });
    return null;
  }

  setAppSettings(db, { [STATE_INSIDE]: cur, [STATE_LAST_TRANSITION]: String(now) });
  return inside ? 'arrive' : 'depart';
}
