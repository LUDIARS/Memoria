// /api/multi/* (Hub 連携) + /api/legatus/location-summary + /api/locations* (GPS)
// + /api/tracks/settings + /api/work-sessions の GPS 取込部分。
// Spec: spec/api/multi.md

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  insertGpsLocation, listGpsLocationsInRange, listGpsLocationDays,
  listGpsLocationsForDate, deleteGpsLocationsOlderThan, compressGpsHistory,
  getAppSettings, setAppSettings,
} from '../db.js';
import {
  readMultiState, isConnected,
  readMultiServers, persistServers, upsertServer, removeServer, findServerByUrl,
  saveServerSession, clearServerSession, setActive,
  readMode, setMode, hubFetch, hubLogin,
} from '../local/multi-client.js';
import { resolveUnresolvedBatch, getResolverDebug } from '../lib/place-resolver.js';
import { featureEnabled } from '../lib/privacy.js';
import { checkIngestKey } from '../lib/ingest-auth.js';
import type { LocationBroadcastPoint, PlaceResolveResult } from '../lib/ws-locations.js';

type Db = BetterSqlite3.Database;

export interface MultiRouterDeps {
  db: Db;
  broadcastLocation: (point: LocationBroadcastPoint) => void;
  broadcastLocationResolved: (id: number, result: PlaceResolveResult | null) => void;
  triggerResolveAsync: (id: number, lat: number, lon: number) => void;
}

export function makeMultiRouter(deps: MultiRouterDeps): Hono {
  const { db, broadcastLocation, broadcastLocationResolved, triggerResolveAsync } = deps;
  const r = new Hono();

  // ---- multi server (Memoria Hub) integration --------------------------------

  r.get('/api/multi/status', (c: Context) => {
    // Returns every registered server + which are active. The legacy
    // `connected/url/user` triple is kept on the response so existing
    // callers keep working: they reflect the FIRST active+connected one.
    const { servers, active } = readMultiServers(db);
    const list = servers.map((s) => ({
      label: s.label, url: s.url,
      active: active.has(s.url),
      connected: !!(s.jwt && s.userId),
      user: s.userId ? { id: s.userId, name: s.userName, role: s.role } : null,
      connected_at: s.connectedAt,
    }));
    const primary = readMultiState(db);
    return c.json({
      servers: list,
      connected: isConnected(primary),
      url: primary.url,
      user: isConnected(primary) ? { id: primary.userId, name: primary.userName, role: primary.role } : null,
      connected_at: primary.connectedAt,
    });
  });

  r.post('/api/multi/servers', async (c: Context) => {
    // Add or update a registered server entry (label + url). Doesn't
    // touch JWT — that's set by the OAuth /finish handler.
    const body = await c.req.json().catch(() => null) as { url?: unknown; label?: unknown } | null;
    if (!body?.url || typeof body.url !== 'string') return c.json({ error: 'url required' }, 400);
    const { servers, active } = readMultiServers(db);
    const updated = upsertServer(servers, { label: typeof body.label === 'string' ? body.label : body.url, url: body.url });
    persistServers(db, updated, active);
    return c.json({ ok: true });
  });

  r.delete('/api/multi/servers', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as { url?: unknown } | null;
    if (!body?.url || typeof body.url !== 'string') return c.json({ error: 'url required' }, 400);
    const { servers, active } = readMultiServers(db);
    active.delete(String(body.url).replace(/\/$/, ''));
    persistServers(db, removeServer(servers, body.url), active);
    return c.json({ ok: true });
  });

  r.post('/api/multi/active', async (c: Context) => {
    // Body: { urls: string[] } — replaces the active set.
    const body = await c.req.json().catch(() => null) as { urls?: unknown } | null;
    if (!Array.isArray(body?.urls)) return c.json({ error: 'urls[] required' }, 400);
    setActive(db, body.urls);
    return c.json({ ok: true });
  });

  // ── 二層設計: Hub に対するログイン ────────────────────────────────────
  //
  // 旧: ローカルが Cernere に直ログイン (CERNERE_BASE_URL を 1 つしか持てず、
  //     複数拠点 Hub に対応できなかった)。
  // 新: ローカルは Cernere を一切知らない。 Hub の /api/auth/login に
  //     email/password を渡すだけ。 Hub が自分の Infisical 由来の
  //     CERNERE_BASE_URL で Cernere に代理ログインし、 session token を返す。
  //     ローカルはその session token を per-hub に保存する。
  r.post('/api/multi/login', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as
      { url?: unknown; email?: unknown; password?: unknown; label?: unknown } | null;
    const url = typeof body?.url === 'string' ? body.url.trim().replace(/\/$/, '') : '';
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!url) return c.json({ error: 'url required' }, 400);
    if (!email || !password) return c.json({ error: 'email / password required' }, 400);

    // 1. server を登録 (未登録なら)
    const { servers, active } = readMultiServers(db);
    const label = typeof body?.label === 'string' && body.label
      ? body.label : (findServerByUrl(servers, url)?.label || url);
    persistServers(db, upsertServer(servers, { url, label }), active);

    // 2. Hub の /api/auth/login に代理ログインを依頼
    let result;
    try {
      result = await hubLogin(url, email, password);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = (e as { status?: number })?.status ?? 502;
      return c.json({ error: `Hub ログイン失敗: ${msg}` }, status as 401);
    }

    // 3. session token を per-hub に保存
    saveServerSession(db, url, {
      jwt: result.sessionToken,
      userId: result.user.userId,
      userName: result.user.displayName,
      role: result.user.role,
    });
    return c.json({ ok: true, url, user: result.user });
  });

  // ── 二層モード: データソース (Local / Multi) の状態 ───────────────────

  r.get('/api/multi/mode', (c: Context) => c.json(readMode(db)));

  // Body: { mode: 'local' | 'multi', url? }
  // Multi にしたい Hub が未ログインなら切り替えず { needs_login: true } を返す。
  r.post('/api/multi/mode', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as { mode?: unknown; url?: unknown } | null;
    const mode = body?.mode === 'multi' ? 'multi' : body?.mode === 'local' ? 'local' : null;
    if (!mode) return c.json({ error: "mode は 'local' か 'multi'" }, 400);
    if (mode === 'local') {
      setMode(db, 'local');
      return c.json({ ok: true, mode: 'local', hubUrl: null });
    }
    const url = typeof body?.url === 'string' ? body.url.trim().replace(/\/$/, '') : '';
    if (!url) return c.json({ error: 'multi モードには url が必要' }, 400);
    const { servers } = readMultiServers(db);
    const s = findServerByUrl(servers, url);
    if (!s || !s.jwt || !s.userId) {
      // 未ログイン — モードは切り替えず frontend にログインを促す
      return c.json({ ok: false, needs_login: true, url });
    }
    setMode(db, 'multi', url);
    return c.json({ ok: true, mode: 'multi', hubUrl: url });
  });

  // 指定 Hub にログイン済か。 ?url=<hub>
  r.get('/api/multi/session', (c: Context) => {
    const url = c.req.query('url') || '';
    if (!url) return c.json({ error: 'url query required' }, 400);
    const { servers } = readMultiServers(db);
    const s = findServerByUrl(servers, url);
    if (s && s.jwt && s.userId) {
      return c.json({
        connected: true,
        user: { id: s.userId, name: s.userName, role: s.role },
      });
    }
    return c.json({ connected: false });
  });

  // Body: { url? } — 指定 Hub の session を破棄。 そのモードに居たら Local に戻す。
  r.post('/api/multi/logout', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as { url?: unknown } | null;
    const url = typeof body?.url === 'string' ? body.url.trim().replace(/\/$/, '') : '';
    if (!url) return c.json({ error: 'url required' }, 400);
    const { servers } = readMultiServers(db);
    const s = findServerByUrl(servers, url);
    if (s && s.jwt) {
      try {
        await hubFetch(s.url, s.jwt, '/api/auth/logout', { method: 'POST' });
      } catch { /* Hub 側破棄はステートレスなので失敗しても続行 */ }
    }
    clearServerSession(db, url);
    const m = readMode(db);
    if (m.mode === 'multi' && m.hubUrl === url) setMode(db, 'local');
    return c.json({ ok: true });
  });

  // ---- GPS locations (OwnTracks) -------------------------------------------

  /**
   * Legatus が 60 秒ごとにまとめて投げる location summary を受ける。
   * loopback / tailnet 内のみ。 認証なし (Memoria 自体が同じ範囲で公開)。
   */
  r.post('/api/legatus/location-summary', async (c: Context) => {
    if (!featureEnabled(db, 'tracks_enabled')) return c.json({ error: 'tracks are disabled' }, 403);
    const body = await c.req.json().catch(() => null) as
      | {
          userId?: unknown; intervalStart?: unknown; intervalEnd?: unknown;
          start?: { lat?: unknown; lon?: unknown };
          end?: { lat?: unknown; lon?: unknown };
          totalDistanceMeters?: unknown; netDistanceMeters?: unknown;
          maxSpeedKmh?: unknown; meanSpeedKmh?: unknown;
          pointCount?: unknown; deviceIds?: unknown;
          source?: { via?: unknown; tool?: unknown; requestId?: unknown };
        }
      | null;
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'json body required' }, 400);
    }
    const userId = (typeof body.userId === 'string' ? body.userId : 'legatus').slice(0, 64);
    const start = body.start;
    const end = body.end;
    if (!start || !end || typeof start.lat !== 'number' || typeof start.lon !== 'number'
        || typeof end.lat !== 'number' || typeof end.lon !== 'number') {
      return c.json({ error: 'start / end (lat,lon) required' }, 400);
    }
    const deviceId = (Array.isArray(body.deviceIds) && typeof body.deviceIds[0] === 'string') ? body.deviceIds[0] : 'legatus';
    const requestId = typeof body.source?.requestId === 'string' ? body.source.requestId : null;
    const meta = {
      via: 'legatus',
      tool: typeof body.source?.tool === 'string' ? body.source.tool : 'owntracks-mqtt',
      requestId,
      pointCount: body.pointCount,
      totalDistanceMeters: body.totalDistanceMeters,
      netDistanceMeters: body.netDistanceMeters,
      maxSpeedKmh: body.maxSpeedKmh,
      meanSpeedKmh: body.meanSpeedKmh,
    };

    const inserted: { id: number; role: 'start' | 'end' }[] = [];
    const intervals: [{ lat: number; lon: number }, unknown, 'start' | 'end'][] = [
      [{ lat: start.lat, lon: start.lon }, body.intervalStart, 'start'],
      [{ lat: end.lat, lon: end.lon }, body.intervalEnd, 'end'],
    ];
    for (const [point, recordedAt, role] of intervals) {
      const rec = {
        userId,
        deviceId,
        tst: undefined,
        recordedAt: typeof recordedAt === 'string' ? recordedAt : new Date().toISOString(),
        lat: point.lat,
        lon: point.lon,
        accuracy: null,
        altitude: null,
        velocity: role === 'end' && typeof body.maxSpeedKmh === 'number' ? body.maxSpeedKmh : null,
        course: null,
        battery: null,
        conn: null,
        rawJson: JSON.stringify({ ...meta, role }),
      };
      const result = insertGpsLocation(db, rec);
      if (!('skipped' in result)) {
        inserted.push({ id: result.id, role });
        broadcastLocation({
          id: result.id,
          user_id: userId,
          device_id: deviceId,
          recorded_at: rec.recordedAt,
          lat: point.lat,
          lon: point.lon,
          accuracy_m: null,
          altitude_m: null,
          velocity_kmh: rec.velocity,
          course_deg: null,
        });
        triggerResolveAsync(result.id, point.lat, point.lon);
      }
    }

    return c.json({ ok: true, inserted, requestId });
  });

  /**
   * 直接 1 点の位置を投入する (OwnTracks HTTP モード or 手動テスト)。
   */
  r.post('/api/locations/ingest', async (c: Context) => {
    if (!featureEnabled(db, 'tracks_enabled')) return c.json({ error: 'tracks are disabled' }, 403);
    const denied = checkIngestKey(db, c);
    if (denied) return denied;

    const body = await c.req.json().catch(() => null) as
      | {
          lat?: unknown; lon?: unknown; tst?: unknown; recorded_at?: unknown;
          device_id?: unknown; tid?: unknown; user_id?: unknown;
          accuracy_m?: unknown; acc?: unknown;
          altitude_m?: unknown; alt?: unknown;
          velocity_kmh?: unknown; vel?: unknown;
          course_deg?: unknown; cog?: unknown;
          battery_pct?: unknown; batt?: unknown;
          conn?: unknown;
        }
      | null;
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'json body required' }, 400);
    }
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return c.json({ error: 'lat / lon required (number)' }, 400);
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return c.json({ error: 'lat / lon out of range' }, 400);
    }

    const deviceId = (typeof body.device_id === 'string' ? body.device_id : null)
      ?? (typeof body.tid === 'string' ? body.tid : null)
      ?? c.req.header('x-limit-d')
      ?? null;
    const tst = typeof body.tst === 'number' ? body.tst : undefined;
    const recordedAt = typeof body.recorded_at === 'string' ? body.recorded_at : undefined;

    const rec = {
      userId: typeof body.user_id === 'string' ? body.user_id : 'me',
      deviceId,
      tst,
      recordedAt,
      lat,
      lon,
      accuracy:  pickNum(body.accuracy_m, body.acc),
      altitude:  pickNum(body.altitude_m, body.alt),
      velocity:  pickNum(body.velocity_kmh, body.vel),
      course:    pickNum(body.course_deg, body.cog),
      battery:   pickNum(body.battery_pct, body.batt),
      conn:      typeof body.conn === 'string' ? body.conn : null,
      rawJson:   JSON.stringify(body),
    };

    const result = insertGpsLocation(db, rec);
    const skipped = 'skipped' in result;
    if (!skipped) {
      // WebSocket subscriber に新規点をブロードキャスト
      broadcastLocation({
        id: result.id,
        user_id: rec.userId,
        device_id: rec.deviceId,
        recorded_at: rec.recordedAt
          ?? (typeof rec.tst === 'number' ? new Date(rec.tst * 1000).toISOString() : new Date().toISOString()),
        lat: rec.lat,
        lon: rec.lon,
        accuracy_m: rec.accuracy,
        altitude_m: rec.altitude,
        velocity_kmh: rec.velocity,
        course_deg: rec.course,
      });
      triggerResolveAsync(result.id, rec.lat, rec.lon);
    }
    // OwnTracks の HTTP モードはレスポンスとして JSON 配列 (友達の cards 等) を
    // 期待するので空配列で返す。
    c.header('X-Memoria-Insert-Id', String(result.id ?? ''));
    c.header('X-Memoria-Insert-Skipped', String(skipped));
    return c.json([]);
  });

  /**
   * Tracks タブ全般の設定.
   *   GET  /api/tracks/settings → { decimate_meters, show_polyline }
   *   PATCH /api/tracks/settings { decimate_meters?, show_polyline? }
   */
  r.get('/api/tracks/settings', (c: Context) => {
    const s = getAppSettings(db);
    const v = Number(s['tracks.decimate_meters'] ?? '0');
    return c.json({
      decimate_meters: Number.isFinite(v) ? v : 0,
      show_polyline: (s['tracks.show_polyline'] ?? 'true') === 'true',
    });
  });
  r.patch('/api/tracks/settings', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { decimate_meters?: unknown; show_polyline?: unknown };
    const patch: Record<string, string> = {};
    if (body.decimate_meters !== undefined) {
      const v = Number(body.decimate_meters);
      if (!Number.isFinite(v) || v < 0 || v > 1000) {
        return c.json({ error: 'decimate_meters must be 0-1000' }, 400);
      }
      patch['tracks.decimate_meters'] = String(v);
    }
    if (body.show_polyline !== undefined) {
      patch['tracks.show_polyline'] = body.show_polyline ? 'true' : 'false';
    }
    if (Object.keys(patch).length > 0) setAppSettings(db, patch);
    const s = getAppSettings(db);
    return c.json({
      decimate_meters: Number(s['tracks.decimate_meters'] ?? '0'),
      show_polyline: (s['tracks.show_polyline'] ?? 'false') === 'true',
    });
  });

  /**
   * GPS ログを最新 N 件 (default 50, max 500) 返す.
   */
  r.get('/api/locations/recent', (c: Context) => {
    if (!featureEnabled(db, 'tracks_visible')) return c.json({ points: [], decimated: 0, pool: 0 });
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? '50')));
    const settingsDecimate = Number(getAppSettings(db)['tracks.decimate_meters'] ?? '0');
    const decimateM = Math.max(0, Number(c.req.query('decimate') ?? settingsDecimate));
    const device = c.req.query('device') || null;
    const params: unknown[] = [];
    let where = '';
    if (device) { where = ' WHERE device_id = ?'; params.push(device); }

    // 新しい順に大きめに取ってから decimate. limit*30 か 1500 の小さい方.
    const pool = Math.max(limit, Math.min(1500, limit * 30));
    const rows = db.prepare(
      `SELECT id, user_id, device_id, recorded_at, lat, lon,
              accuracy_m, altitude_m, velocity_kmh, course_deg, raw_json,
              place_name, place_address, place_source
       FROM gps_locations${where} ORDER BY id DESC LIMIT ?`,
    ).all(...params, pool) as { lat: number; lon: number }[];

    if (decimateM <= 0) {
      return c.json({ points: rows.slice(0, limit), decimated: 0, pool: rows.length });
    }

    const R = 6_371_008;
    const toRad = (d: number) => (d * Math.PI) / 180;
    function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
      const f1 = toRad(a.lat), f2 = toRad(b.lat);
      const df = toRad(b.lat - a.lat), dl = toRad(b.lon - a.lon);
      const h = Math.sin(df/2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl/2) ** 2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    const kept: { lat: number; lon: number }[] = [];
    for (const p of rows) {
      if (kept.length === 0) { kept.push(p); continue; }
      const last = kept[kept.length - 1];
      if (distM(last, p) >= decimateM) {
        kept.push(p);
        if (kept.length >= limit) break;
      }
    }
    return c.json({ points: kept, decimated: decimateM, pool: rows.length });
  });

  /** 直近 1 件の GPS 点を返す。 */
  r.get('/api/locations/latest', (c: Context) => {
    if (!featureEnabled(db, 'tracks_visible')) return c.json({ point: null });
    const row = db.prepare(
      `SELECT id, user_id, device_id, recorded_at, lat, lon,
              accuracy_m, altitude_m, velocity_kmh, course_deg,
              place_name, place_address, place_source
       FROM gps_locations ORDER BY recorded_at DESC LIMIT 1`,
    ).get() as unknown;
    return c.json({ point: row ?? null });
  });

  /**
   * 期間内の点を時系列順で返す。
   */
  r.get('/api/locations', (c: Context) => {
    if (!featureEnabled(db, 'tracks_visible')) return c.json({ points: [] });
    const url = new URL(c.req.url);
    const date = url.searchParams.get('date');
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return c.json({ error: 'date must be YYYY-MM-DD' }, 400);
      }
      const points = listGpsLocationsForDate(db, date);
      // 同じ日付の transit_rides も時系列に乗せて返す (UI 側で別レイヤとして描画)。
      const rides = db.prepare(
        `SELECT id, from_station, to_station, line_name, train_type,
                departure_at, arrival_at, duration_min, fare_yen,
                from_lat, from_lon, arrival_lat, arrival_lon
           FROM transit_rides
          WHERE date(coalesce(departure_at, recorded_at)) = ?
          ORDER BY coalesce(departure_at, recorded_at) ASC`,
      ).all(date);
      return c.json({ date, points, transit_rides: rides });
    }
    const from = url.searchParams.get('from') ?? undefined;
    const to   = url.searchParams.get('to') ?? undefined;
    const deviceId = url.searchParams.get('device') ?? undefined;
    const points = listGpsLocationsInRange(db, { from, to, deviceId });
    return c.json({ from, to, deviceId: deviceId ?? null, points });
  });

  /** 位置情報を持っている日と件数。 UI の date picker 用。 */
  r.get('/api/locations/days', (c: Context) => {
    if (!featureEnabled(db, 'tracks_visible')) return c.json({ days: [] });
    const limit = Math.min(Number(c.req.query('limit') ?? 365) || 365, 3650);
    const days = listGpsLocationDays(db, { limit });
    return c.json({ days });
  });

  /** 古い位置情報を一括削除。 retention 用。 */
  r.delete('/api/locations', (c: Context) => {
    if (!featureEnabled(db, 'tracks_enabled')) return c.json({ error: 'tracks are disabled' }, 403);
    const denied = checkIngestKey(db, c);
    if (denied) return denied;
    const olderThan = c.req.query('older_than');
    if (!olderThan) return c.json({ error: 'older_than (ISO) required' }, 400);
    const removed = deleteGpsLocationsOlderThan(db, olderThan);
    return c.json({ removed });
  });

  /** 未解決 GPS 点をまとめて場所照合する */
  r.get('/api/locations/resolve-debug', (c: Context) => c.json(getResolverDebug()));

  r.post('/api/locations/resolve-all', async (c: Context) => {
    if (!featureEnabled(db, 'tracks_enabled')) return c.json({ error: 'tracks are disabled' }, 403);
    let body: { limit?: unknown; step_ms?: unknown; reset?: unknown } = {};
    try { body = await c.req.json() as typeof body; } catch { /* ignore */ }
    const limit = Math.min(500, Math.max(1, Number(body.limit ?? 100)));
    const stepMs = Math.max(0, Number(body.step_ms ?? 150));
    let resetCount = 0;
    if (body.reset === true || body.reset === 1) {
      const info = db.prepare(
        `UPDATE gps_locations SET place_resolved_at = NULL, place_source = NULL
          WHERE place_source = 'failed'`,
      ).run();
      resetCount = info.changes;
    }
    const r2 = await resolveUnresolvedBatch(db, {
      limit,
      stepMs,
      onResolved: (id, result) => broadcastLocationResolved(id, result),
    });
    return c.json({ ...r2, reset: resetCount });
  });

  /**
   * 既存 GPS 履歴を遡及圧縮する (停止区間の中間点を削除し、 始点+終点 2 行に集約)。
   */
  r.post('/api/locations/compress', async (c: Context) => {
    if (!featureEnabled(db, 'tracks_enabled')) return c.json({ error: 'tracks are disabled' }, 403);
    let body: { device_id?: unknown; threshold?: unknown } = {};
    try { body = await c.req.json() as typeof body; } catch { /* ignore */ }
    const deviceId = typeof body.device_id === 'string' && body.device_id.length > 0 ? body.device_id : null;
    const thresholdNum = Number(body.threshold);
    const threshold = Number.isFinite(thresholdNum) && thresholdNum > 0 ? thresholdNum : undefined;
    const summary = compressGpsHistory(db, { deviceId, threshold });
    return c.json(summary);
  });

  return r;
}

function pickNum(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === 'number' && isFinite(v)) return v;
  }
  return null;
}

