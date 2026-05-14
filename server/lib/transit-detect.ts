// GPS の速度履歴から「乗車区間」 を検出して transit_rides に自動 insert。
//
// 検出基準:
//   - velocity_kmh が MIN_TRAVEL_SPEED 以上の点が MIN_TRAVEL_MS 以上続く
//   - 移動中の点は GPS 精度が荒れる (Doppler / multipath / tunnel) ので位置情報には使わない
//   - 移動の終わり = velocity_kmh が SETTLED_SPEED を MIN_SETTLED_MS 連続で下回った時点
//   - 「終点」 として採用する位置は settled に入った最初の点 (= 駅で降車 → 改札に向かう前)
//   - 「始点」 として採用する位置は移動開始の直前まで安定していた settled 点 (= 入線直前の改札周辺)
//
// 駅特定: Google Places (New) で includedTypes=train_station,subway_station,
// bus_station を指定した nearby search。 半径 200m / 上位 1 件。 既存
// place-resolver と同じ API key 解決ルールを使う (= MEMORIA_PLACES_API_KEY >
// GOOGLE_MAPS_API_KEY > app_settings)。
//
// dedupe: gps_end_id を UNIQUE 索引で保護しているので 「同じ終点 GPS row」
// に対しては 2 行作られない (= 検出器を何度走らせても idempotent)。

import type BetterSqlite3 from 'better-sqlite3';
import {
  listGpsLocationsInRange, getAppSettings,
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
const STATION_RADIUS_M = 200;
const PLACES_TIMEOUT_MS = 5_000;
const PLACES_NEW_URL = 'https://places.googleapis.com/v1/places:searchNearby';

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

// ── 駅特定 (Google Places New) ──────────────────────────────────────────

interface PlacesNearbyResponse {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    shortFormattedAddress?: string;
    types?: string[];
  }>;
}

export interface StationLookupResult {
  name: string | null;
  address: string | null;
  types: string[];
}

function readPlacesApiKey(db: Db): string {
  const env = process.env.MEMORIA_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (env) return env;
  const settings = getAppSettings(db);
  return settings?.['maps.api_key'] || '';
}

/** lat/lon の半径 200m 以内で 一番近い train/subway/bus station を 1 件取る。 */
export async function lookupNearestStation(db: Db, lat: number, lon: number): Promise<StationLookupResult | null> {
  const apiKey = readPlacesApiKey(db);
  if (!apiKey) return null;
  const body = {
    maxResultCount: 1,
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lon },
        radius: STATION_RADIUS_M,
      },
    },
    includedTypes: ['train_station', 'subway_station', 'bus_station', 'transit_station', 'light_rail_station'],
    languageCode: 'ja',
    regionCode: 'JP',
    rankPreference: 'DISTANCE',
  };
  try {
    const res = await fetch(PLACES_NEW_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.types',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PLACES_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = await res.json() as PlacesNearbyResponse;
    const r = j.places?.[0];
    if (!r) return null;
    return {
      name: r.displayName?.text ?? null,
      address: r.shortFormattedAddress ?? r.formattedAddress ?? null,
      types: r.types ?? [],
    };
  } catch {
    return null;
  }
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
    const [from, to] = await Promise.all([
      lookupNearestStation(db, w.start_point.lat, w.start_point.lon),
      lookupNearestStation(db, w.end_point.lat, w.end_point.lon),
    ]);
    if (!from?.name || !to?.name) continue;
    result.station_resolved += 2;
    const durationMin = Math.round(w.duration_ms / 60_000);
    const lineGuess = guessLineFromSpeed(w.max_speed_kmh);
    const notes = `🛰 GPS 自動検出 (max ${Math.round(w.max_speed_kmh)} km/h)`;
    try {
      insertStmt.run(
        from.name, to.name, lineGuess,
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
