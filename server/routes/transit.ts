// /api/transit/* — Google Directions ベースの経路検索 + 乗った電車の記録。
//
// Ekispert free 廃止に伴い切替。 経路 + 駅 (Place) は Memoria 既設の
// maps.api_key を流用。 Directions は real-time の遅延を到着時刻に反映するので
// 「いま見て次の電車」 用途では Ekispert より使い勝手が良い。
// 運行情報の独立リストは廃止 (= 検索結果に warnings として出る)。

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  searchStations, searchRoutes,
  type GoogleTransitConfig, type SearchCourse, type SearchSegment,
} from '../lib/transit-google.js';
import { getAppSettings } from '../db.js';
import { runDetection } from '../lib/transit-detect.js';
import { searchStationsLocal } from '../lib/transit-stations-seed.js';

type Db = BetterSqlite3.Database;

export interface TransitRouterDeps { db: Db }

interface TransitRideRow {
  id: number;
  recorded_at: string;
  from_station: string;
  to_station: string;
  line_name: string | null;
  train_type: string | null;
  departure_at: string | null;
  arrival_at: string | null;
  duration_min: number | null;
  fare_yen: number | null;
  from_lat: number | null;
  from_lon: number | null;
  arrival_lat: number | null;
  arrival_lon: number | null;
  transfer_count: number;
  segments_json: string | null;
  notes: string | null;
  detected_from_gps: number;
  gps_start_id: number | null;
  gps_end_id: number | null;
  max_speed_kmh: number | null;
}

function loadGoogleConfig(db: Db): GoogleTransitConfig {
  const env = process.env.MEMORIA_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (env) return { apiKey: env };
  const s = getAppSettings(db);
  return { apiKey: s['maps.api_key'] || '' };
}

export function makeTransitRouter(deps: TransitRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  // ── 設定状態。 maps.api_key を使い回すので独自 key は持たない。 ─────────
  r.get('/api/transit/config', (c: Context) => {
    const cfg = loadGoogleConfig(db);
    return c.json({ hasKey: !!cfg.apiKey, source: 'maps.api_key' });
  });

  // ── 駅検索 (Places Autocomplete fallback)。 通常はローカル DB を使う。 ─────
  r.get('/api/transit/stations', async (c: Context) => {
    const url = new URL(c.req.url);
    const q = url.searchParams.get('q') ?? '';
    if (!q.trim()) return c.json({ items: [] });
    try {
      const stations = await searchStations(loadGoogleConfig(db), q);
      return c.json({ items: stations });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 502);
    }
  });

  // ── 駅検索: ローカル DB (HeartRails seed 由来) + GPS 近さ + ターミナル優先 ─
  // ?q=新宿&lat=35.69&lon=139.69&limit=20
  // lat/lon を省略すると 直近 gps_locations を使う (= 「いまどこにいるか」 を
  // 自動推定して近い順)。
  r.get('/api/transit/stations/local', (c: Context) => {
    const url = new URL(c.req.url);
    const q = url.searchParams.get('q') ?? '';
    if (!q.trim()) return c.json({ items: [] });
    let lat = Number(url.searchParams.get('lat'));
    let lon = Number(url.searchParams.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const row = db.prepare(`SELECT lat, lon FROM gps_locations ORDER BY recorded_at DESC LIMIT 1`).get() as { lat: number; lon: number } | undefined;
      if (row) { lat = row.lat; lon = row.lon; }
    }
    const limit = Number(url.searchParams.get('limit'));
    const items = searchStationsLocal(db, {
      q,
      lat: Number.isFinite(lat) ? lat : undefined,
      lon: Number.isFinite(lon) ? lon : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return c.json({
      items,
      gps_source: Number.isFinite(lat) && Number.isFinite(lon)
        ? (url.searchParams.get('lat') ? 'query' : 'gps') : null,
    });
  });

  // ── 経路検索 (= Directions mode=transit) ───────────────────────────────
  // ?from=<place_id:... or 駅名>&to=<...>&datetime=ISO&mode=departure|arrival
  // datetime 未指定なら 'now' (= 現在出発、 遅延加味済の到着時刻が返る)。
  r.get('/api/transit/search', async (c: Context) => {
    const url = new URL(c.req.url);
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    if (!from || !to) return c.json({ error: 'from / to required' }, 400);
    const datetime = url.searchParams.get('datetime');
    const mode = url.searchParams.get('mode') === 'arrival' ? 'arrival' : 'departure';
    let when: Date | undefined;
    if (datetime) {
      const d = new Date(datetime);
      if (Number.isNaN(d.getTime())) return c.json({ error: 'datetime invalid ISO' }, 400);
      when = d;
    }
    try {
      const courses = await searchRoutes(loadGoogleConfig(db), {
        origin: from, destination: to, timeMode: mode, when,
      });
      return c.json({ courses });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 502);
    }
  });

  // ── 乗った電車の記録 (= rides) ────────────────────────────────────────
  //
  // 検索結果 (= SearchCourse) を post して 「乗った」 と記録するのが王道。
  // 手動入力 (= 駅名 / 路線名 / 時刻) でも作れる。

  interface CreateRideBody {
    from_station?: string;
    to_station?: string;
    line_name?: string;
    train_type?: string;
    departure_at?: string;
    arrival_at?: string;
    duration_min?: number;
    fare_yen?: number;
    transfer_count?: number;
    segments?: SearchSegment[];
    from_lat?: number;
    from_lon?: number;
    arrival_lat?: number;
    arrival_lon?: number;
    notes?: string;
    /** SearchCourse をそのまま投げてもいい。 segments + duration + fare を抽出 */
    course?: SearchCourse;
  }

  r.post('/api/transit/rides', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as CreateRideBody;
    let from_station = body.from_station;
    let to_station = body.to_station;
    let segments: SearchSegment[] | undefined = body.segments;
    let line_name = body.line_name;
    let train_type = body.train_type;
    let departure_at = body.departure_at;
    let arrival_at = body.arrival_at;
    let duration_min = body.duration_min;
    let fare_yen = body.fare_yen;
    let transfer_count = body.transfer_count ?? 0;
    // SearchCourse をそのまま渡された場合の抽出
    if (body.course) {
      segments = body.course.segments;
      duration_min = body.course.duration_min;
      fare_yen = body.course.fare_yen;
      transfer_count = body.course.transfer_count ?? 0;
      const first = body.course.segments[0];
      const last = body.course.segments[body.course.segments.length - 1];
      from_station ??= first?.from_station;
      to_station ??= last?.to_station;
      line_name ??= first?.line;
      train_type ??= first?.train_type;
      departure_at ??= first?.departure_at ?? undefined;
      arrival_at ??= last?.arrival_at ?? undefined;
    }
    if (!from_station || !to_station) return c.json({ error: 'from_station / to_station required' }, 400);
    const stmt = db.prepare(
      `INSERT INTO transit_rides
        (from_station, to_station, line_name, train_type,
         departure_at, arrival_at, duration_min, fare_yen,
         from_lat, from_lon, arrival_lat, arrival_lon,
         transfer_count, segments_json, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const info = stmt.run(
      from_station, to_station,
      line_name ?? null, train_type ?? null,
      departure_at ?? null, arrival_at ?? null,
      duration_min ?? null, fare_yen ?? null,
      body.from_lat ?? null, body.from_lon ?? null,
      body.arrival_lat ?? null, body.arrival_lon ?? null,
      transfer_count,
      segments ? JSON.stringify(segments) : null,
      body.notes ?? null,
    );
    return c.json({ id: Number(info.lastInsertRowid) }, 201);
  });

  r.get('/api/transit/rides', (c: Context) => {
    const url = new URL(c.req.url);
    const date = url.searchParams.get('date');
    const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 50));
    let rows: TransitRideRow[];
    if (date) {
      // YYYY-MM-DD の日付で departure_at もしくは recorded_at が範囲内
      rows = db.prepare(
        `SELECT * FROM transit_rides
          WHERE (date(coalesce(departure_at, recorded_at)) = ?)
          ORDER BY coalesce(departure_at, recorded_at) ASC`,
      ).all(date) as TransitRideRow[];
    } else {
      rows = db.prepare(
        `SELECT * FROM transit_rides ORDER BY recorded_at DESC LIMIT ?`,
      ).all(limit) as TransitRideRow[];
    }
    return c.json({ items: rows.map(toRideOutput) });
  });

  /** GPS 履歴からの一括検出を手動トリガ。 ?since=ISO で起点を変えられる。 */
  r.post('/api/transit/detect', async (c: Context) => {
    const url = new URL(c.req.url);
    const since = url.searchParams.get('since') ?? undefined;
    try {
      const r2 = await runDetection(db, { since });
      return c.json(r2);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 500);
    }
  });

  r.delete('/api/transit/rides/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const info = db.prepare(`DELETE FROM transit_rides WHERE id = ?`).run(id);
    return c.json({ deleted: info.changes });
  });

  return r;
}

interface RideOutput {
  id: number;
  recorded_at: string;
  from_station: string;
  to_station: string;
  line_name: string | null;
  train_type: string | null;
  departure_at: string | null;
  arrival_at: string | null;
  duration_min: number | null;
  fare_yen: number | null;
  from_lat: number | null;
  from_lon: number | null;
  arrival_lat: number | null;
  arrival_lon: number | null;
  transfer_count: number;
  segments: SearchSegment[];
  notes: string | null;
  detected_from_gps: boolean;
  max_speed_kmh: number | null;
}

function toRideOutput(row: TransitRideRow): RideOutput {
  let segments: SearchSegment[] = [];
  if (row.segments_json) {
    try { segments = JSON.parse(row.segments_json) as SearchSegment[]; } catch { segments = []; }
  }
  return {
    id: row.id,
    recorded_at: row.recorded_at,
    from_station: row.from_station,
    to_station: row.to_station,
    line_name: row.line_name,
    train_type: row.train_type,
    departure_at: row.departure_at,
    arrival_at: row.arrival_at,
    duration_min: row.duration_min,
    fare_yen: row.fare_yen,
    from_lat: row.from_lat,
    from_lon: row.from_lon,
    arrival_lat: row.arrival_lat,
    arrival_lon: row.arrival_lon,
    transfer_count: row.transfer_count,
    segments,
    notes: row.notes,
    detected_from_gps: !!row.detected_from_gps,
    max_speed_kmh: row.max_speed_kmh,
  };
}
