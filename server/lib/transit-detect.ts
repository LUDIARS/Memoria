// GPS の速度履歴から「乗車区間」 を検出して transit_rides に自動 insert。
//
// 検出基準:
//   - velocity_kmh が MIN_TRAVEL_SPEED 以上の点が MIN_TRAVEL_MS 以上続く
//   - 移動中の点は GPS 精度が荒れる (Doppler / multipath / tunnel) ので位置情報には使わない
//   - 移動の終わり = velocity_kmh が SETTLED_SPEED を MIN_SETTLED_MS 連続で下回った時点
//   - 「終点」 として採用する位置は settled に入った最初の点 (= 駅で降車 → 改札に向かう前)
//   - 「始点」 として採用する位置は移動開始の直前まで安定していた settled 点 (= 入線直前の改札周辺)
//
// 駅特定: ローカル DB (HeartRails seed 済の stations 表) で 50m 半径の
// 最近傍を検索。 Google Places を叩かないので API 課金 / referer 制限が無く、
// 駅判定が毎回安定する。 50m は OwnTracks の locator displacement と整合し、
// かつ複数駅が同じ円に入りにくい現実的な誤差幅。
//
// dedupe: gps_end_id を UNIQUE 索引で保護しているので 「同じ終点 GPS row」
// に対しては 2 行作られない (= 検出器を何度走らせても idempotent)。

import type BetterSqlite3 from 'better-sqlite3';
import {
  listGpsLocationsInRange,
  type GpsLocationInRangeRow,
} from '../db.js';

type Db = BetterSqlite3.Database;

// ── tuning ─────────────────────────────────────────────────────────────
//
// MIN_TRAVEL_SPEED は徒歩 (4-6) / 自転車 (15-20) を排除し、 バス / 電車を
// 拾う狙い。 自動車も拾うがそれは出力タグでハイブリッド扱いに。
//
// MIN_TRAVEL_MS は 「一駅 / バス 1 区間」 が成立する短めの window を取る。
// 短すぎると赤信号で停車したマイカーまで拾うので 3 分。
//
// MIN_SETTLED_MS は 「駅停車 ≠ 終着」 を区別する。 駅での停車は 1-2 分なので
// 3 分静止すれば本当に降りたとみなす。
//
const MIN_TRAVEL_SPEED = 25;             // km/h
const SETTLED_SPEED = 5;                 // km/h
const MIN_TRAVEL_MS = 3 * 60_000;
const MIN_SETTLED_MS = 3 * 60_000;
/** 終点 GPS 点からの「ここはこの駅」 判定半径。 OwnTracks locator
 *  displacement と整合する 50m を採用 (= 改札を出てから周辺を歩いて
 *  settled に入る程度の誤差幅)。 */
const STATION_RADIUS_M = 50;

export interface DetectedWindow {
  start_point: GpsLocationInRangeRow;
  end_point: GpsLocationInRangeRow;
  max_speed_kmh: number;
  duration_ms: number;
  travel_start_at: string;     // 移動状態に入った最初の point の時刻
}

/** 速度履歴 state-machine 本体。 `points` は recorded_at ASC 順を想定。 */
export function detectWindows(points: GpsLocationInRangeRow[]): DetectedWindow[] {
  const out: DetectedWindow[] = [];
  let lastSettled: GpsLocationInRangeRow | null = null;
  let travelStart: GpsLocationInRangeRow | null = null;        // 移動 window の最初 high-speed 点
  let maxSpeed = 0;
  let settledStart: GpsLocationInRangeRow | null = null;       // settle 候補に入った最初の点

  for (const p of points) {
    const v = p.velocity_kmh ?? 0;
    if (v >= MIN_TRAVEL_SPEED) {
      if (travelStart == null) {
        travelStart = p;
        maxSpeed = v;
      } else {
        if (v > maxSpeed) maxSpeed = v;
      }
      // settle 候補は破棄 — まだ動いている
      settledStart = null;
    } else if (v < SETTLED_SPEED) {
      if (travelStart == null) {
        lastSettled = p;
      } else {
        if (settledStart == null) settledStart = p;
        const settleMs = new Date(p.recorded_at).getTime() - new Date(settledStart.recorded_at).getTime();
        if (settleMs >= MIN_SETTLED_MS) {
          const travelMs = new Date(settledStart.recorded_at).getTime() - new Date(travelStart.recorded_at).getTime();
          if (travelMs >= MIN_TRAVEL_MS) {
            out.push({
              start_point: lastSettled ?? travelStart,
              end_point: settledStart,
              max_speed_kmh: maxSpeed,
              duration_ms: travelMs,
              travel_start_at: travelStart.recorded_at,
            });
          }
          // window をリセット → 次の travel 検出待ち
          travelStart = null;
          maxSpeed = 0;
          settledStart = null;
          lastSettled = p;
        }
      }
    } else {
      // 中間速度 (徒歩〜自転車): settle 候補をキャンセル、 travel も継続中なら維持
      if (settledStart != null) settledStart = null;
    }
  }
  return out;
}

// ── 駅特定 (ローカル DB: stations 表) ─────────────────────────────────

export interface StationLookupResult {
  name: string | null;
  /** 「都道府県」 (= 利用者がどこで降りたかの粗いラベル) */
  prefecture: string | null;
  /** 該当した路線名 (= 距離 50m 以内に複数路線あれば代表 1 件) */
  line: string | null;
  /** マッチした駅の lat/lon (= GPS 点との直線距離は別途付与) */
  lat: number;
  lon: number;
  distance_m: number;
}

/**
 * 与えた lat/lon の半径 STATION_RADIUS_M (= 50m) 以内で 一番近い駅を 1 件返す。
 *
 * - bounding box で候補を粗く絞り (= SQL の lat/lon 不等号、 索引で高速)、
 *   JS で Haversine 厳密化 → 50m 以内かつ最短を選ぶ。
 * - 同じ駅名で複数 line がある場合は最も近い row を採用 (= 駅自体の座標は
 *   普通 1 点なのでどの line でも同じ座標)。
 * - 駅が見つからなければ null。
 */
export function lookupNearestStation(db: Db, lat: number, lon: number): StationLookupResult | null {
  // 緯度 1 度 ≒ 111 km、 経度 1 度 ≒ 111*cos(lat) km。
  // 50m 検索なら bbox を 1 km 角に広く取って候補に上げる (= 索引で速い + 余裕)。
  const dLat = STATION_RADIUS_M * 4 / 111_000;
  const dLon = STATION_RADIUS_M * 4 / (111_000 * Math.cos(lat * Math.PI / 180));
  const minLat = lat - dLat, maxLat = lat + dLat;
  const minLon = lon - dLon, maxLon = lon + dLon;

  const rows = db.prepare(
    `SELECT name, line, prefecture, lat, lon
       FROM stations
      WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`,
  ).all(minLat, maxLat, minLon, maxLon) as Array<{
    name: string; line: string; prefecture: string | null; lat: number; lon: number;
  }>;
  if (rows.length === 0) return null;

  let best: { row: typeof rows[number]; dist: number } | null = null;
  for (const r of rows) {
    const d = haversine(lat, lon, r.lat, r.lon);
    if (d > STATION_RADIUS_M) continue;
    if (!best || d < best.dist) best = { row: r, dist: d };
  }
  if (!best) return null;
  return {
    name: best.row.name,
    prefecture: best.row.prefecture,
    line: best.row.line,
    lat: best.row.lat,
    lon: best.row.lon,
    distance_m: Math.round(best.dist),
  };
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ── 検出器を回す ──────────────────────────────────────────────────────

export interface RunDetectionOptions {
  /** 走査する GPS 履歴の起点 (ISO)。 既定は 24h 前。 */
  since?: string;
}

export interface RunDetectionResult {
  scanned: number;
  windows: number;
  inserted: number;
  station_resolved: number;
  skipped_dup: number;
}

/**
 * 期間内 GPS を走査して未登録の乗車を transit_rides に append。
 *
 * 駅名が取れなかった場合は ride を作らない (= 「どこで乗ったか分からない」
 * は記録としての価値が薄い)。 後日 API key を直したら再走査で拾われる。
 */
export async function runDetection(db: Db, opts: RunDetectionOptions = {}): Promise<RunDetectionResult> {
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const points = listGpsLocationsInRange(db, { from: since });
  const windows = detectWindows(points);
  const result: RunDetectionResult = {
    scanned: points.length,
    windows: windows.length,
    inserted: 0,
    station_resolved: 0,
    skipped_dup: 0,
  };

  const existsStmt = db.prepare(`SELECT 1 FROM transit_rides WHERE gps_end_id = ? LIMIT 1`);
  const insertStmt = db.prepare(
    `INSERT INTO transit_rides
       (from_station, to_station, line_name, train_type,
        departure_at, arrival_at, duration_min, fare_yen,
        from_lat, from_lon, arrival_lat, arrival_lon,
        transfer_count, segments_json, notes,
        detected_from_gps, gps_start_id, gps_end_id, max_speed_kmh)
     VALUES (?, ?, ?, NULL,
             ?, ?, ?, NULL,
             ?, ?, ?, ?,
             0, NULL, ?,
             1, ?, ?, ?)`,
  );

  for (const w of windows) {
    if (existsStmt.get(w.end_point.id)) { result.skipped_dup++; continue; }
    const from = lookupNearestStation(db, w.start_point.lat, w.start_point.lon);
    const to = lookupNearestStation(db, w.end_point.lat, w.end_point.lon);
    if (!from?.name || !to?.name) continue;
    result.station_resolved += 2;
    const durationMin = Math.round(w.duration_ms / 60_000);
    // 駅 DB から取れた両端の line を優先採用 (両端で同じ路線なら確度高)、
    // 違えば速度ヒューリスティックに fallback。
    let lineName = guessLineFromSpeed(w.max_speed_kmh);
    if (from.line && to.line && from.line === to.line) {
      lineName = from.line;
    } else if (from.line && to.line) {
      lineName = `${from.line} → ${to.line}`;
    }
    const notes = `🛰 GPS 自動検出 (max ${Math.round(w.max_speed_kmh)} km/h, ${from.distance_m}m + ${to.distance_m}m 駅近傍)`;
    try {
      insertStmt.run(
        from.name, to.name, lineName,
        w.travel_start_at, w.end_point.recorded_at, durationMin,
        w.start_point.lat, w.start_point.lon, w.end_point.lat, w.end_point.lon,
        notes,
        w.start_point.id, w.end_point.id, w.max_speed_kmh,
      );
      result.inserted++;
    } catch {
      // UNIQUE 違反 (= 並行検出 / 既に作られていた): スキップ。
      result.skipped_dup++;
    }
  }
  return result;
}

/** 最大速度から大雑把な交通機関を推定 (= UI の 「電車?バス?」 ヒント)。 */
function guessLineFromSpeed(maxKmh: number): string {
  if (maxKmh >= 120) return '新幹線級';
  if (maxKmh >= 70) return '電車';
  if (maxKmh >= 40) return '電車/車';
  return 'バス/車';
}
