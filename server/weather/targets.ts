// 天気の対象地点を決める。
//   - 自宅 (work_locations.is_home=1) は必須
//   - 「その曜日に行きがちな場所」 は登録済み work_locations の中から、 過去の
//     gps_locations 履歴 (同じ曜日) が各地点の半径内に何回入ったかで候補化し、
//     最終選定を weather.likely_place ブラックボックスに委ねる。

import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings } from '../db.js';
import type { BlackBoxEngine } from '../blackbox/index.js';
import { decideLikelyPlaces, type PlaceStat } from './domains.js';

type Db = BetterSqlite3.Database;

export interface RegisteredPlace {
  name: string; lat: number; lon: number; isHome: boolean; radiusM: number;
}

export interface TargetPlace {
  name: string; lat: number; lon: number;
  kind: 'home' | 'likely';
  /** likely のとき: rule/llm のどちらが選んだか + 説明。 */
  source?: 'rule' | 'llm';
  rationale?: string;
}

const DOW_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function listRegisteredPlaces(db: Db): RegisteredPlace[] {
  const defRadius = Number(getAppSettings(db)['workplace_match_radius_m']) || 200;
  const rows = db.prepare(
    `SELECT name, latitude, longitude, is_home, radius_m FROM work_locations
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
  ).all() as Array<{ name: string; latitude: number; longitude: number; is_home: number; radius_m: number | null }>;
  return rows.map((r) => ({
    name: r.name, lat: r.latitude, lon: r.longitude,
    isHome: r.is_home === 1,
    radiusM: r.radius_m && r.radius_m > 0 ? r.radius_m : defRadius,
  }));
}

export function getHome(db: Db): RegisteredPlace | null {
  return listRegisteredPlaces(db).find((p) => p.isHome) ?? null;
}

/** 過去 sinceDays 日の gps を曜日で絞り、 各登録地点の半径内訪問回数を数える。 */
function countVisitsByDow(db: Db, places: RegisteredPlace[], dow: number, sinceDays = 90): Map<string, number> {
  const counts = new Map<string, number>(places.map((p) => [p.name, 0]));
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(
    `SELECT lat, lon, recorded_at FROM gps_locations WHERE recorded_at >= ?`,
  ).all(since) as Array<{ lat: number; lon: number; recorded_at: string }>;
  for (const r of rows) {
    const d = new Date(r.recorded_at);
    if (Number.isNaN(d.getTime()) || d.getDay() !== dow) continue;
    for (const p of places) {
      if (haversineM(r.lat, r.lon, p.lat, p.lon) <= p.radiusM) {
        counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
        break;                          // 1 点は最も近い 1 地点に数える
      }
    }
  }
  return counts;
}

/**
 * 今日の対象地点を決める。 自宅は必ず含む。 行きがちな場所は blackbox 判定。
 * 同名の自宅は重複させない。
 */
export async function resolveTargets(
  db: Db, engine: BlackBoxEngine, now = new Date(),
): Promise<TargetPlace[]> {
  const places = listRegisteredPlaces(db);
  const home = places.find((p) => p.isHome) ?? null;
  const targets: TargetPlace[] = [];
  if (home) targets.push({ name: home.name, lat: home.lat, lon: home.lon, kind: 'home' });

  const dow = now.getDay();
  const nonHome = places.filter((p) => !p.isHome);
  if (nonHome.length > 0) {
    const counts = countVisitsByDow(db, nonHome, dow);
    const candidates: PlaceStat[] = nonHome.map((p) => ({
      name: p.name, lat: p.lat, lon: p.lon, visitsThisDow: counts.get(p.name) ?? 0,
    }));
    const result = await decideLikelyPlaces(engine, { dow, dowName: DOW_NAMES[dow], candidates });
    for (const name of result.names) {
      const place = nonHome.find((p) => p.name === name);
      if (place && !targets.some((t) => t.name === place.name)) {
        targets.push({
          name: place.name, lat: place.lat, lon: place.lon, kind: 'likely',
          source: result.source, rationale: result.rationale,
        });
      }
    }
  }
  return targets;
}
