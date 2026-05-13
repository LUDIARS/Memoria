// /api/transit/* — Ekispert ベースの経路検索 + 乗った電車の記録。
//
// 検索系 (stations / search / first / last / lines) は Ekispert API key 必須。
// 記録系 (rides) は key 無しでも動く (= 手動入力 + 検索結果取り込みの両対応)。

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  searchStations, searchRoutes, firstTrain, lastTrain, listOperationLines,
  type EkispertConfig, type SearchCourse, type SearchSegment,
} from '../lib/transit-ekispert.js';
import { getAppSettings, setAppSettings } from '../db.js';

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
}

function loadEkispertConfig(db: Db): EkispertConfig {
  const s = getAppSettings(db);
  return { apiKey: s['transit.ekispert_api_key'] || process.env.EKISPERT_API_KEY || '' };
}

export function makeTransitRouter(deps: TransitRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  // ── 設定: API key の保存/取得 ─────────────────────────────────────────
  r.get('/api/transit/config', (c: Context) => {
    const cfg = loadEkispertConfig(db);
    return c.json({ hasKey: !!cfg.apiKey });
  });
  r.patch('/api/transit/config', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { apiKey?: unknown };
    if (typeof body.apiKey !== 'string') return c.json({ error: 'apiKey (string) required' }, 400);
    setAppSettings(db, { 'transit.ekispert_api_key': body.apiKey.trim() });
    return c.json({ ok: true });
  });

  // ── 駅検索 ────────────────────────────────────────────────────────────
  r.get('/api/transit/stations', async (c: Context) => {
    const url = new URL(c.req.url);
    const q = url.searchParams.get('q') ?? '';
    if (!q.trim()) return c.json({ items: [] });
    try {
      const stations = await searchStations(loadEkispertConfig(db), q);
      return c.json({ items: stations });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 502);
    }
  });

  // ── 経路検索 ──────────────────────────────────────────────────────────
  // ?from=<code>&to=<code>&date=YYYYMMDD&time=HHMM&searchType=plain|firstTrain|lastTrain
  r.get('/api/transit/search', async (c: Context) => {
    const url = new URL(c.req.url);
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    if (!from || !to) return c.json({ error: 'from / to (station code) required' }, 400);
    const searchType = url.searchParams.get('searchType') ?? 'plain';
    try {
      const courses = await searchRoutes(loadEkispertConfig(db), {
        viaCodes: [from, to],
        date: url.searchParams.get('date') ?? undefined,
        time: url.searchParams.get('time') ?? undefined,
        searchType: searchType as 'plain' | 'departure' | 'arrival' | 'firstTrain' | 'lastTrain',
      });
      return c.json({ courses });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 502);
    }
  });

  // ── 始発検索 (= 翌朝最初の電車) ───────────────────────────────────────
  r.get('/api/transit/first', async (c: Context) => {
    const url = new URL(c.req.url);
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    if (!from || !to) return c.json({ error: 'from / to required' }, 400);
    try {
      const courses = await firstTrain(loadEkispertConfig(db), from, to, url.searchParams.get('date') ?? undefined);
      return c.json({ courses });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 502);
    }
  });

  // ── 終電検索 ──────────────────────────────────────────────────────────
  r.get('/api/transit/last', async (c: Context) => {
    const url = new URL(c.req.url);
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    if (!from || !to) return c.json({ error: 'from / to required' }, 400);
    try {
      const courses = await lastTrain(loadEkispertConfig(db), from, to, url.searchParams.get('date') ?? undefined);
      return c.json({ courses });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 502);
    }
  });

  // ── 運行情報 (= 遅延一覧)。 free tier では status null になる。 ───────────
  r.get('/api/transit/lines', async (c: Context) => {
    try {
      const lines = await listOperationLines(loadEkispertConfig(db));
      // delay 表示用にフィルタ: status が non-null かつ '平常運転' でない行だけ
      const url = new URL(c.req.url);
      const onlyDelay = url.searchParams.get('only_delay') === '1';
      const filtered = onlyDelay
        ? lines.filter((ln) => ln.status && !/平常|運転中/.test(ln.status))
        : lines;
      return c.json({ items: filtered });
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
  };
}
