// /api/work-locations*, /api/workplaces*, /api/work-sessions
// Spec: spec/api/workplace.md

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  listWorkLocations, getWorkLocation, insertWorkLocation,
  updateWorkLocation, deleteWorkLocation,
  listGpsLocationsForDate,
  getAppSettings, setAppSettings,
} from '../db.js';
import {
  readMultiState, isConnected, shareWorkplacePresence,
} from '../local/multi-client.js';
import { privacySettings } from '../lib/privacy.js';

type Db = BetterSqlite3.Database;

interface ActivityCountRow { kind: string; n: number }

// Haversine distance in meters between two {lat,lng} points.
function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export interface WorkplaceRouterDeps {
  db: Db;
}

export function makeWorkplaceRouter(deps: WorkplaceRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  r.get('/api/work-locations', (c: Context) => {
    const limit = Math.min(Number(c.req.query('limit') || 200), 500);
    const offset = Math.max(0, Number(c.req.query('offset') || 0));
    return c.json({ items: listWorkLocations(db, { limit, offset }) });
  });

  r.post('/api/work-locations', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as
      { name?: unknown; address?: unknown; latitude?: unknown; longitude?: unknown;
        description?: unknown; url?: unknown; tags?: unknown; shareable?: unknown };
    const name = String(body.name ?? '').trim();
    if (!name) return c.json({ error: 'name required' }, 400);
    const id = insertWorkLocation(db, {
      name,
      address: typeof body.address === 'string' ? body.address.trim() : null,
      latitude: body.latitude == null || body.latitude === '' ? null : Number(body.latitude),
      longitude: body.longitude == null || body.longitude === '' ? null : Number(body.longitude),
      description: typeof body.description === 'string' ? body.description.trim() : null,
      url: typeof body.url === 'string' ? body.url.trim() : null,
      tags: typeof body.tags === 'string' ? body.tags.trim() : null,
      shareable: !!body.shareable,
    });
    return c.json({ location: getWorkLocation(db, id) }, 201);
  });

  r.patch('/api/work-locations/:id', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!getWorkLocation(db, id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as
      { name?: unknown; address?: unknown; latitude?: unknown; longitude?: unknown;
        description?: unknown; url?: unknown; tags?: unknown; shareable?: unknown };
    const patch: Record<string, unknown> = {};
    if (typeof body.name === 'string') patch.name = body.name.trim();
    if (typeof body.address === 'string' || body.address === null) patch.address = body.address;
    if (body.latitude === null || body.latitude === '' || body.latitude === undefined) {
      if ('latitude' in body) patch.latitude = null;
    } else patch.latitude = Number(body.latitude);
    if (body.longitude === null || body.longitude === '' || body.longitude === undefined) {
      if ('longitude' in body) patch.longitude = null;
    } else patch.longitude = Number(body.longitude);
    if (typeof body.description === 'string' || body.description === null) patch.description = body.description;
    if (typeof body.url === 'string' || body.url === null) patch.url = body.url;
    if (typeof body.tags === 'string' || body.tags === null) patch.tags = body.tags;
    if (typeof body.shareable === 'boolean') patch.shareable = body.shareable;
    updateWorkLocation(db, id, patch);
    return c.json({ location: getWorkLocation(db, id) });
  });

  r.delete('/api/work-locations/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!getWorkLocation(db, id)) return c.json({ error: 'not found' }, 404);
    deleteWorkLocation(db, id);
    return c.json({ ok: true });
  });

  // ── Place API: reverse geocode a lat/lng to {name, address}
  //
  // Default provider: OpenStreetMap Nominatim (free, no API key, but
  // rate-limited and User-Agent required). Switchable via
  // `places.api.url` setting.
  r.post('/api/work-locations/resolve-place', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { latitude?: unknown; longitude?: unknown };
    const lat = Number(body.latitude);
    const lng = Number(body.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return c.json({ error: 'latitude+longitude required' }, 400);
    }
    const settings = getAppSettings(db);
    const baseUrl = (settings['places.api.url'] || 'https://nominatim.openstreetmap.org/reverse').replace(/\/+$/, '');
    const ua = settings['places.api.ua'] || 'Memoria/0.2 (workplace resolver)';
    const url = `${baseUrl}?format=jsonv2&zoom=18&addressdetails=1&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': ua, 'Accept': 'application/json', 'Accept-Language': 'ja,en;q=0.5' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return c.json({ error: `place api ${res.status}` }, 502);
      const json = await res.json() as {
        name?: string;
        display_name?: string;
        lat?: string | number;
        lon?: string | number;
        osm_id?: number;
        type?: string;
        category?: string;
        address?: Record<string, string>;
      };
      const a = json.address ?? {};
      const name = json.name || a.amenity || a.shop || a.office || a.building
        || a.tourism || a.leisure || a.public_building || a.road
        || (json.display_name || '').split(',')[0] || '';
      return c.json({
        name: String(name).trim().slice(0, 120),
        address: String(json.display_name ?? '').slice(0, 240),
        latitude: Number(json.lat ?? lat),
        longitude: Number(json.lon ?? lng),
        raw: { osm_id: json.osm_id, type: json.type, category: json.category },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `place api: ${msg}` }, 502);
    }
  });

  // ── Checkin: GPS coords → match nearest local work_location → broadcast
  // to Hub if user opted-in and the workplace changed since last checkin.
  r.post('/api/work-locations/checkin', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { latitude?: unknown; longitude?: unknown };
    const lat = Number(body.latitude);
    const lng = Number(body.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return c.json({ error: 'latitude+longitude required' }, 400);
    }
    const settings = privacySettings(db);
    if (!settings.workplace_geo_enabled) {
      return c.json({ error: 'workplace_geo disabled' }, 403);
    }
    const radius = Math.max(20, Math.min(2000, Number(settings.workplace_match_radius_m) || 150));

    // Find nearest workplace within radius.
    const all = listWorkLocations(db, { limit: 500 });
    let matched: typeof all[number] | null = null;
    let matchedDist = Infinity;
    for (const w of all) {
      if (!Number.isFinite(w.latitude) || !Number.isFinite(w.longitude)) continue;
      const d = haversineMeters({ lat, lng }, { lat: w.latitude as number, lng: w.longitude as number });
      if (d <= radius && d < matchedDist) {
        matched = w;
        matchedDist = d;
      }
    }

    const appS = getAppSettings(db);
    const lastId = appS['workplace.current.id'] ? Number(appS['workplace.current.id']) : null;
    const now = new Date().toISOString();
    const result: {
      matched: boolean;
      workplace: typeof all[number] | null;
      distance_m: number | null;
      changed: boolean;
      broadcast: { ok: boolean; id?: number; occurred_at?: string; error?: string; kind?: string } | null;
    } = {
      matched: !!matched,
      workplace: matched,
      distance_m: matched ? Math.round(matchedDist) : null,
      changed: false,
      broadcast: null,
    };

    if (matched) {
      if (lastId !== matched.id) {
        result.changed = true;
        setAppSettings(db, {
          'workplace.current.id': String(matched.id),
          'workplace.current.at': now,
        });

        // Optional broadcast to Hub.
        if (settings.workplace_auto_share_enabled) {
          try {
            const state = readMultiState(db);
            if (isConnected(state)) {
              const r2 = await shareWorkplacePresence(state, {
                workplace_name: matched.name,
                address: matched.address,
                latitude: matched.latitude,
                longitude: matched.longitude,
                kind: 'enter',
              });
              result.broadcast = { ok: true, id: r2.id, occurred_at: r2.occurred_at };
            } else {
              result.broadcast = { ok: false, error: 'not_connected' };
            }
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[workplace/checkin] broadcast failed', e);
            result.broadcast = { ok: false, error: msg };
          }
        }
      }
    } else if (lastId) {
      // We left the previously matched workplace.
      result.changed = true;
      const prev = getWorkLocation(db, lastId);
      setAppSettings(db, { 'workplace.current.id': '', 'workplace.current.at': now });
      if (prev && settings.workplace_auto_share_enabled) {
        try {
          const state = readMultiState(db);
          if (isConnected(state)) {
            await shareWorkplacePresence(state, {
              workplace_name: prev.name,
              address: prev.address,
              latitude: prev.latitude,
              longitude: prev.longitude,
              kind: 'leave',
            });
            result.broadcast = { ok: true, kind: 'leave' };
          }
        } catch (e: unknown) {
          console.error('[workplace/checkin] leave broadcast failed', e);
        }
      }
    }
    return c.json(result);
  });

  /**
   * GPS 軌跡 + 作業場所カタログから「その日の仕事セッション」を検出する。
   *
   * 検出ルール:
   *   - 各 GPS 点について最近接の work_location (lat/lng 設定済) を探し、
   *     **50m 以内** ならその場所に居たと見なす (iPhone の GPS accuracy_m
   *     は 14-47m 程度なので 10m だと取りこぼす).
   *   - 同じ workplace 上の連続点を 1 セッションにまとめる。
   *   - **継続 60 分以上** のセッションだけを採用 (短滞在は除外)。
   *   - workplace 名に "自宅" を含む場合は、 セッション窓内の activity_events
   *     (git_commit / claude_code_prompt / etc.) が 1 件以上あるときのみ
   *     `is_working = true` とする。 ない場合は private time として除外しない
   *     が working フラグを立てない。
   *   - その他の場所は常に `is_working = true`。
   */
  r.get('/api/work-sessions', (c: Context) => {
    const date = c.req.query('date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ error: 'date=YYYY-MM-DD required' }, 400);
    }
    const points = listGpsLocationsForDate(db, date);
    if (!points.length) return c.json({ date, items: [] });

    const places = listWorkLocations(db, { limit: 500 }).filter((w): w is typeof w & { latitude: number; longitude: number } =>
      Number.isFinite(w.latitude) && Number.isFinite(w.longitude),
    );
    if (!places.length) return c.json({ date, items: [] });

    const placesById = new Map(places.map((p) => [p.id, p]));

    function distMeters(p1: { lat: number; lon: number }, p2: { lat: number; lon: number }): number {
      const R = 6_371_008;
      const toRad = (d: number) => (d * Math.PI) / 180;
      const f1 = toRad(p1.lat), f2 = toRad(p2.lat);
      const df = toRad(p2.lat - p1.lat), dl = toRad(p2.lon - p1.lon);
      const h = Math.sin(df/2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl/2) ** 2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    const settings = privacySettings(db);
    const RADIUS_M = Math.max(20, Math.min(2000, Number(settings.workplace_match_radius_m) || 50));

    const tagged = points.map((p) => {
      let bestId: number | null = null;
      let bestDist = Infinity;
      for (const w of places) {
        const d = distMeters({ lat: p.lat, lon: p.lon }, { lat: w.latitude, lon: w.longitude });
        if (d <= RADIUS_M && d < bestDist) {
          bestId = w.id;
          bestDist = d;
        }
      }
      return { recorded_at: p.recorded_at, workplace_id: bestId };
    });

    interface RawSession { workplace_id: number; started_at: string; ended_at: string; points: number }
    const sessions: RawSession[] = [];
    let cur: RawSession | null = null;
    for (const t of tagged) {
      if (!cur) {
        if (t.workplace_id) {
          cur = { workplace_id: t.workplace_id, started_at: t.recorded_at, ended_at: t.recorded_at, points: 1 };
        }
        continue;
      }
      if (t.workplace_id === cur.workplace_id) {
        cur.ended_at = t.recorded_at;
        cur.points += 1;
      } else {
        cur.ended_at = t.recorded_at;
        sessions.push(cur);
        cur = t.workplace_id
          ? { workplace_id: t.workplace_id, started_at: t.recorded_at, ended_at: t.recorded_at, points: 1 }
          : null;
      }
    }
    if (cur) sessions.push(cur);

    // 継続 60 分ルール + working 判定
    const MIN_DURATION_MIN = 60;
    const allSessions = sessions.map((s) => {
      const w = placesById.get(s.workplace_id);
      const startMs = Date.parse(s.started_at);
      const endMs = Date.parse(s.ended_at);
      const durationMin = Math.max(0, Math.round((endMs - startMs) / 60000));
      const isHome = (w?.name ?? '').includes('自宅') || /home/i.test(w?.name ?? '');
      const out = {
        workplace_id: s.workplace_id,
        workplace_name: w?.name ?? '',
        workplace_address: w?.address ?? '',
        started_at: s.started_at,
        ended_at: s.ended_at,
        duration_min: durationMin,
        points_count: s.points,
        is_home: isHome,
        is_working: !isHome,
        activity_counts: {} as Record<string, number>,
      };
      // 自宅: activity_events で working 判定
      const acts = db.prepare(`
        SELECT kind, COUNT(*) AS n
        FROM activity_events
        WHERE occurred_at >= ? AND occurred_at <= ?
        GROUP BY kind
      `).all(s.started_at, s.ended_at) as ActivityCountRow[];
      for (const a of acts) out.activity_counts[a.kind] = a.n;
      const totalActs = acts.reduce((acc, a) => acc + a.n, 0);
      if (isHome) out.is_working = totalActs > 0;
      return out;
    });

    // tallies は短いセッションも含める。 items は ≥60 分のみ。
    const tallies: { home_minutes: number; workplace_minutes: number; by_workplace: Record<string, number> } = {
      home_minutes: 0, workplace_minutes: 0, by_workplace: {},
    };
    for (const s of allSessions) {
      if (s.is_home) tallies.home_minutes += s.duration_min;
      else tallies.workplace_minutes += s.duration_min;
      tallies.by_workplace[s.workplace_name] = (tallies.by_workplace[s.workplace_name] ?? 0) + s.duration_min;
    }
    const items = allSessions.filter((s) => s.duration_min >= MIN_DURATION_MIN);

    return c.json({ date, items, tallies });
  });

  return r;
}
