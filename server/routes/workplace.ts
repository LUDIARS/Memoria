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
import { getCurrentWifiInfo, hasWiredConnection } from '../lib/wifi-info.js';

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

  // 接続中の WiFi 情報 (Memoria server プロセスが動いている PC で検出)。
  // どのクライアント (Electron renderer / 別 PC のブラウザ / スマホ PWA / Chrome
  // 拡張) から叩いても、 同じ「Memoria サーバ機の WiFi」 を返す。
  // → Electron で起動した Memoria に Web から接続している場合も SSID が見える。
  //
  // 結果は SSID + BSSID + 有線接続有無 + 解決済み workplace + 解決ソース。
  // 解決優先度: GPS (= OwnTracks の最近の gps_locations) > WiFi (SSID マッチ) >
  // 有線 (= is_home の workplace)。 endpoint 名は `/api/wifi/current` のまま
  // 後方互換 (旧クライアントの fetch でも壊れない)、 中身は network 全般。
  r.get('/api/wifi/current', async (c: Context) => {
    const settings = privacySettings(db);
    if (!settings.workplace_geo_enabled) {
      return c.json({ supported: false, reason: 'workplace_geo disabled' });
    }
    const info = await getCurrentWifiInfo();
    const wired = hasWiredConnection();
    const all = listWorkLocations(db, { limit: 500 });

    // 1) WiFi SSID マッチ
    let workplace: { id: number; name: string } | null = null;
    let source: 'wifi' | 'wired' | null = null;
    if (info?.ssid) {
      const norm = info.ssid.toLowerCase();
      const hit = all.find((w) => {
        const list = (w.wifi_ssids ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        return list.includes(norm);
      });
      if (hit) { workplace = { id: hit.id, name: hit.name }; source = 'wifi'; }
    }
    // 2) 有線 (= is_home の workplace に fallback)
    if (!workplace && wired) {
      const home = all.find((w) => w.is_home === 1);
      if (home) { workplace = { id: home.id, name: home.name }; source = 'wired'; }
    }

    return c.json({
      supported: true,
      ssid: info?.ssid ?? null,
      bssid: info?.bssid ?? null,
      platform: info?.platform ?? process.platform,
      wired,
      workplace,
      source,
    });
  });

  r.get('/api/work-locations', (c: Context) => {
    const limit = Math.min(Number(c.req.query('limit') || 200), 500);
    const offset = Math.max(0, Number(c.req.query('offset') || 0));
    return c.json({ items: listWorkLocations(db, { limit, offset }) });
  });

  r.post('/api/work-locations', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as
      { name?: unknown; address?: unknown; latitude?: unknown; longitude?: unknown;
        description?: unknown; url?: unknown; tags?: unknown; wifi_ssids?: unknown;
        is_home?: unknown; shareable?: unknown; radius_m?: unknown };
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
      wifi_ssids: typeof body.wifi_ssids === 'string' ? body.wifi_ssids.trim() : null,
      is_home: !!body.is_home,
      shareable: !!body.shareable,
      radius_m: body.radius_m == null || body.radius_m === '' ? null : Number(body.radius_m),
    });
    return c.json({ location: getWorkLocation(db, id) }, 201);
  });

  r.patch('/api/work-locations/:id', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!getWorkLocation(db, id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as
      { name?: unknown; address?: unknown; latitude?: unknown; longitude?: unknown;
        description?: unknown; url?: unknown; tags?: unknown; wifi_ssids?: unknown;
        is_home?: unknown; shareable?: unknown; radius_m?: unknown };
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
    if (typeof body.wifi_ssids === 'string' || body.wifi_ssids === null) patch.wifi_ssids = body.wifi_ssids;
    if (typeof body.is_home === 'boolean') patch.is_home = body.is_home;
    if (typeof body.shareable === 'boolean') patch.shareable = body.shareable;
    if (body.radius_m === null || body.radius_m === '' || body.radius_m === undefined) {
      if ('radius_m' in body) patch.radius_m = null;
    } else {
      const r = Number(body.radius_m);
      if (Number.isFinite(r) && r > 0) patch.radius_m = Math.max(1, Math.min(50_000, r));
    }
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
    const globalRadius = Math.max(20, Math.min(2000, Number(settings.workplace_match_radius_m) || 150));

    // Find nearest workplace within its own radius (per-place `radius_m` column
    // が NULL なら global default を使う)。 「最も近い」 は「正規化距離 d / r」
    // ではなく「実距離 d」 で比較する (= 半径が大きい場所が必ず勝つわけではない)。
    const all = listWorkLocations(db, { limit: 500 });
    let matched: typeof all[number] | null = null;
    let matchedDist = Infinity;
    for (const w of all) {
      if (!Number.isFinite(w.latitude) || !Number.isFinite(w.longitude)) continue;
      const r = (typeof w.radius_m === 'number' && w.radius_m > 0) ? w.radius_m : globalRadius;
      const d = haversineMeters({ lat, lng }, { lat: w.latitude as number, lng: w.longitude as number });
      if (d <= r && d < matchedDist) {
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

  // ── WiFi SSID 経由のチェックイン (Electron 起動時に呼ばれる) ─────────────
  //
  // GPS / 位置情報 permission を経由せず、 接続中の WiFi 名 (SSID) から「ここに
  // 居る」 を判定する経路。 work_locations.wifi_ssids (カンマ区切り) に該当 SSID
  // が登録されていれば、 そのワークプレイスを current として扱う。
  //
  // 「Electron 起動時のみ」 = renderer 側で window.memoria.getCurrentWifiInfo()
  // が使える状況でのみ呼ばれる、 という運用 (= サーバ側は呼ばれたら処理する)。
  r.post('/api/work-locations/wifi-checkin', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { ssid?: unknown; bssid?: unknown };
    const ssid = typeof body.ssid === 'string' ? body.ssid.trim() : '';
    if (!ssid) return c.json({ error: 'ssid required' }, 400);
    const settings = privacySettings(db);
    if (!settings.workplace_geo_enabled) {
      return c.json({ error: 'workplace_geo disabled' }, 403);
    }

    // SSID は大文字小文字を区別しない。 wifi_ssids はカンマ区切り。
    const norm = ssid.toLowerCase();
    const all = listWorkLocations(db, { limit: 500 });
    let matched = all.find((w) => {
      const list = (w.wifi_ssids ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      return list.includes(norm);
    }) ?? null;

    // Fallback: SSID に対応 workplace が無くても、 PC が有線接続なら is_home を
    // current に置く (= 「OwnTracks > WiFi > 有線」 の優先度ルール)。
    let resolutionSource: 'wifi' | 'wired' = 'wifi';
    if (!matched && hasWiredConnection()) {
      const home = all.find((w) => w.is_home === 1);
      if (home) { matched = home; resolutionSource = 'wired'; }
    }

    const appS = getAppSettings(db);
    const lastId = appS['workplace.current.id'] ? Number(appS['workplace.current.id']) : null;
    const now = new Date().toISOString();
    const result: {
      matched: boolean;
      workplace: typeof all[number] | null;
      ssid: string;
      source: 'wifi' | 'wired' | null;
      changed: boolean;
      broadcast: { ok: boolean; id?: number; occurred_at?: string; error?: string; kind?: string } | null;
    } = { matched: !!matched, workplace: matched, ssid, source: matched ? resolutionSource : null, changed: false, broadcast: null };

    if (matched) {
      if (lastId !== matched.id) {
        result.changed = true;
        setAppSettings(db, {
          'workplace.current.id': String(matched.id),
          'workplace.current.at': now,
          // どの経路で current になったかを記録 (debug / UI 用)
          'workplace.current.source': resolutionSource === 'wired' ? 'wired:home' : `wifi:${ssid}`,
        });
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
            result.broadcast = { ok: false, error: msg };
          }
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
    const GLOBAL_RADIUS_M = Math.max(20, Math.min(2000, Number(settings.workplace_match_radius_m) || 50));
    // 移動速度の閾値 (km/h)。 これより速い瞬間速度の GPS 点は「移動中」 と
    // 見なして workplace タグ付けの対象から外す (= 通り過ぎただけの場所を誤検出しない)。
    // 既定 5 km/h (= 徒歩速度上限近辺)。 0 にすると速度フィルタ無効。
    const MAX_SPEED_KMH = Math.max(0, Number(settings.workplace_max_speed_kmh) || 5);
    const MAX_SPEED_MPS = MAX_SPEED_KMH > 0 ? (MAX_SPEED_KMH * 1000) / 3600 : Infinity;

    // 速度計算: 各点について「直前点との距離 / 時間差」 で瞬間速度を出す。
    // 最初の点は速度不明 → 含める。
    const tsMs = (s: string): number => {
      const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
      return Number.isFinite(t) ? t : 0;
    };
    const speedFiltered = points.map((p, i) => {
      if (i === 0 || MAX_SPEED_MPS === Infinity) return { p, fast: false };
      const prev = points[i - 1];
      const d = distMeters({ lat: p.lat, lon: p.lon }, { lat: prev.lat, lon: prev.lon });
      const dt = (tsMs(p.recorded_at) - tsMs(prev.recorded_at)) / 1000;
      if (dt <= 0) return { p, fast: false };
      const v = d / dt;
      return { p, fast: v > MAX_SPEED_MPS };
    });

    const tagged = speedFiltered.map(({ p, fast }) => {
      if (fast) return { recorded_at: p.recorded_at, workplace_id: null };
      let bestId: number | null = null;
      let bestDist = Infinity;
      for (const w of places) {
        const r = (typeof w.radius_m === 'number' && w.radius_m > 0) ? w.radius_m : GLOBAL_RADIUS_M;
        const d = distMeters({ lat: p.lat, lon: p.lon }, { lat: w.latitude, lon: w.longitude });
        if (d <= r && d < bestDist) {
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
