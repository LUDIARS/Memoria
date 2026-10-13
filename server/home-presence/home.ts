// 自宅の座標と半径の解決。 作業場所の自宅 (is_home=1) を優先し、 無ければ天気の固定座標。

import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings } from '../db.js';
import type { HomePlace } from './types.js';

type Db = BetterSqlite3.Database;

/** 作業場所に半径が無いときの自宅半径 (m)。 */
export const DEFAULT_WORK_LOCATION_HOME_RADIUS_M = 150;
/** 天気の固定座標を使うときの自宅半径 (m)。 旧 gps トリガーの既定と同じ。 */
export const WEATHER_HOME_RADIUS_M = 200;

function validLatLon(lat: unknown, lon: unknown): lat is number {
  return typeof lat === 'number' && typeof lon === 'number'
    && Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    && !(lat === 0 && lon === 0);
}

export function resolveHome(db: Db): HomePlace | null {
  const row = db.prepare(`
    SELECT name, latitude, longitude, radius_m FROM work_locations
    WHERE is_home = 1 AND latitude IS NOT NULL AND longitude IS NOT NULL
    ORDER BY id LIMIT 1
  `).get() as { name: string; latitude: number; longitude: number; radius_m: number | null } | undefined;
  if (row && validLatLon(row.latitude, row.longitude)) {
    const r = Number(row.radius_m);
    return {
      lat: row.latitude,
      lon: row.longitude,
      radiusM: Number.isFinite(r) && r > 0 ? r : DEFAULT_WORK_LOCATION_HOME_RADIUS_M,
      source: 'work_location',
      name: row.name,
    };
  }
  const s = getAppSettings(db);
  const lat = Number(s['weather.fixed_lat']);
  const lon = Number(s['weather.fixed_lon']);
  if (validLatLon(lat, lon)) {
    return { lat, lon, radiusM: WEATHER_HOME_RADIUS_M, source: 'weather', name: '天気の固定座標' };
  }
  return null;
}
