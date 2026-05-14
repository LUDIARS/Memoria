// /api/transit/* — 駅検索 (ローカル DB) + 乗った電車の記録 + GPS 自動検出。
//
// 経路探索は frontend で Google Maps へ deep-link するだけ (= サーバ API なし)。
// Google Routes API は日本の鉄道に非対応 (TRANSIT mode が 0 件) のため。
// Ekispert は free 廃止。 結果として:
//   - 駅 autocomplete: ローカル stations 表 (HeartRails seed)。 Places は fallback
//   - 経路探索: Google Maps deep-link (frontend)
//   - 乗車記録: 手動 / GPS 自動検出

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  searchStations,
  type GoogleTransitConfig, type SearchSegment,
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
    const latStr = url.searchParams.get('lat');
    const lonStr = url.searchParams.get('lon');
    let lat: number | undefined;
    let lon: number | undefined;
    let source: 'query' | 'gps' | null = null;
    if (latStr != null && lonStr != null) {
      const ql = Number(latStr); const qg = Number(lonStr);
      if (Number.isFinite(ql) && Number.isFinite(qg)) { lat = ql; lon = qg; source = 'query'; }
    }
    if (lat === undefined) {
      const row = db.prepare(`SELECT lat, lon FROM gps_locations ORDER BY recorded_at DESC LIMIT 1`).get() as { lat: number; lon: number } | undefined;
      if (row && Number.isFinite(row.lat) && Number.isFinite(row.lon)) {
        lat = row.lat; lon = row.lon; source = 'gps';
      }
    }
    const limitStr = url.searchParams.get('limit');
    const limitN = limitStr != null ? Number(limitStr) : NaN;
    const items = searchStationsLocal(db, {
      q, lat, lon,
      limit: Number.isFinite(limitN) ? limitN : undefined,
    });
    return c.json({ items, gps_source: source });
  });

  // 経路検索 API は廃止 (= Google Routes API が日本の鉄道に非対応)。
  // frontend が Google Maps へ deep-link する。

  // ── 乗った電車の記録 (= rides) ────────────────────────────────────────
  //
  // 手動入力 (= 駅名 / 路線名 / 時刻) で作る。 GPS 自動検出は別経路 (detect)。

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
  }

  r.post('/api/transit/rides', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as CreateRideBody;
    const from_station = body.from_station;
    const to_station = body.to_station;
    const segments: SearchSegment[] | undefined = body.segments;
    const line_name = body.line_name;
    const train_type = body.train_type;
    const departure_at = body.departure_at;
    const arrival_at = body.arrival_at;
    const duration_min = body.duration_min;
    const fare_yen = body.fare_yen;
    const transfer_count = body.transfer_count ?? 0;
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
