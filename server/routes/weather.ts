// /api/weather/* — Open-Meteo forecast + 日記用 snapshot
//
// クライアントは「今日の天気カード」 表示と日記表示の 2 箇所で叩く。
// scheduler から雨アラート用に内部的にも叩くので、 fetch は lib/weather.ts に
// 切り出してこのファイルは薄い transport にする。
//
// 既定の位置解決:
//   1. ?lat=&lon= が両方付いていればそれを使う (= 強制指定)
//   2. app_settings に `weather.fixed_lat` / `weather.fixed_lon` があればそれ
//   3. 直近 gps_locations 1 点
//   4. (どれも無ければ 404)

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  fetchForecast,
  insertWeatherSnapshot,
  getLatestSnapshotForDate,
  getMostRecentSnapshot,
  readLatestGpsLatLon,
  rowToForecast,
  describeCode,
  isRainingNow,
  nextRainStart,
  type Forecast,
} from '../lib/weather.js';
import { getAppSettings, setAppSettings } from '../db.js';
import { featureEnabled } from '../lib/privacy.js';
import type { BlackBoxEngine } from '../blackbox/index.js';
import { getWeatherConfig } from '../weather/config.js';
import { ALL_SOURCES } from '../weather/sources/index.js';
import { hoursForDay } from '../weather/ensemble.js';
import { runAndStoreEnsemble } from '../weather/ensemble-service.js';
import { listEnsembleSnapshots, getEnsembleSnapshot } from '../weather/ensemble-store.js';
import { resolveTargets } from '../weather/targets.js';
import { buildBriefing } from '../weather/briefing.js';

type Db = BetterSqlite3.Database;

export interface WeatherRouterDeps { db: Db; engine: BlackBoxEngine }

/** 「今日」 の YYYY-MM-DD (server local TZ)。 weather snapshot の date キーに使う。 */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function resolveLocation(db: Db, c: Context): { lat: number; lon: number; source: string } | null {
  const url = new URL(c.req.url);
  const qLat = Number(url.searchParams.get('lat'));
  const qLon = Number(url.searchParams.get('lon'));
  if (Number.isFinite(qLat) && Number.isFinite(qLon)) {
    return { lat: qLat, lon: qLon, source: 'query' };
  }
  const s = getAppSettings(db);
  const fLat = Number(s['weather.fixed_lat']);
  const fLon = Number(s['weather.fixed_lon']);
  if (Number.isFinite(fLat) && Number.isFinite(fLon) && (fLat !== 0 || fLon !== 0)) {
    return { lat: fLat, lon: fLon, source: 'fixed' };
  }
  const gps = readLatestGpsLatLon(db);
  if (gps) return { ...gps, source: 'gps' };
  return null;
}

export function makeWeatherRouter(deps: WeatherRouterDeps): Hono {
  const { db, engine } = deps;
  const r = new Hono();

  /** その日の天気 (= 「天気カード」 用)。 lat/lon 不問 (内部解決)。
   *  fetch するたびに snapshot を保存。 30 分以内に同じ date の row が
   *  あればそれを返す (re-fetch 抑制)。 ?force=1 で再 fetch。 */
  r.get('/api/weather/today', async (c: Context) => {
    if (!featureEnabled(db, 'weather_enabled')) {
      return c.json({ error: 'weather feature disabled' }, 404);
    }
    const date = todayLocal();
    const url = new URL(c.req.url);
    const force = url.searchParams.get('force') === '1';
    // 直近 snapshot があれば cache (30 分)
    if (!force) {
      const cached = getLatestSnapshotForDate(db, date);
      if (cached && Date.now() - cached.fetched_at < 30 * 60 * 1000) {
        const f = rowToForecast(cached);
        return c.json({
          date, lat: cached.lat, lon: cached.lon,
          fetched_at: cached.fetched_at, source: 'cache',
          forecast: f, summary: summarize(f, date),
        });
      }
    }
    const loc = resolveLocation(db, c);
    if (!loc) return c.json({ error: 'no location available — set ?lat= & lon=, weather.fixed_lat/lon, or enable GPS' }, 400);
    try {
      const f = await fetchForecast(loc.lat, loc.lon);
      insertWeatherSnapshot(db, date, f);
      return c.json({
        date, lat: loc.lat, lon: loc.lon,
        fetched_at: Date.now(), source: loc.source,
        forecast: f, summary: summarize(f, date),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `fetch failed: ${msg}` }, 502);
    }
  });

  /** 明示 lat/lon で「いま」 の forecast を取る (snapshot 保存しない)。 */
  r.get('/api/weather/forecast', async (c: Context) => {
    if (!featureEnabled(db, 'weather_enabled')) {
      return c.json({ error: 'weather feature disabled' }, 404);
    }
    const url = new URL(c.req.url);
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return c.json({ error: 'lat and lon required' }, 400);
    }
    try {
      const f = await fetchForecast(lat, lon);
      return c.json({ forecast: f, summary: summarize(f, todayLocal()) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `fetch failed: ${msg}` }, 502);
    }
  });

  /** 指定 date の保存済 snapshot を返す。 無ければ 404。 日記閲覧時に呼ぶ。 */
  r.get('/api/weather/snapshot/:date', (c: Context) => {
    const date = c.req.param('date') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
    const row = getLatestSnapshotForDate(db, date);
    if (!row) return c.json({ error: 'no snapshot' }, 404);
    const f = rowToForecast(row);
    return c.json({
      date, lat: row.lat, lon: row.lon, fetched_at: row.fetched_at,
      forecast: f, summary: summarize(f, date),
    });
  });

  /** 固定 lat/lon の設定読み出し + 更新。 UI から GPS 無し環境で天気を使うため。 */
  r.get('/api/weather/config', (c: Context) => {
    const s = getAppSettings(db);
    const fLat = Number(s['weather.fixed_lat']);
    const fLon = Number(s['weather.fixed_lon']);
    const hasFixed = Number.isFinite(fLat) && Number.isFinite(fLon) && (fLat !== 0 || fLon !== 0);
    return c.json({
      fixed_lat: hasFixed ? fLat : null,
      fixed_lon: hasFixed ? fLon : null,
      rain_alert_enabled: featureEnabled(db, 'weather_rain_alert_enabled'),
    });
  });

  r.patch('/api/weather/config', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { lat?: unknown; lon?: unknown };
    const patch: Record<string, string> = {};
    if (body.lat === null || body.lat === '') {
      patch['weather.fixed_lat'] = '';
    } else if (body.lat !== undefined) {
      const v = Number(body.lat);
      if (!Number.isFinite(v) || v < -90 || v > 90) return c.json({ error: 'lat must be -90..90' }, 400);
      patch['weather.fixed_lat'] = String(v);
    }
    if (body.lon === null || body.lon === '') {
      patch['weather.fixed_lon'] = '';
    } else if (body.lon !== undefined) {
      const v = Number(body.lon);
      if (!Number.isFinite(v) || v < -180 || v > 180) return c.json({ error: 'lon must be -180..180' }, 400);
      patch['weather.fixed_lon'] = String(v);
    }
    if (Object.keys(patch).length === 0) return c.json({ error: 'lat or lon required' }, 400);
    setAppSettings(db, patch);
    return c.json({ ok: true });
  });

  /** 直近の snapshot (= どの date でもいいので最も新しい行)。 */
  r.get('/api/weather/latest', (c: Context) => {
    const row = getMostRecentSnapshot(db);
    if (!row) return c.json({ error: 'no snapshot' }, 404);
    const f = rowToForecast(row);
    return c.json({
      date: row.date, lat: row.lat, lon: row.lon, fetched_at: row.fetched_at,
      forecast: f, summary: summarize(f, row.date),
    });
  });

  // ── マルチソース ──────────────────────────────────────────────────────

  /** 1 地点を全ソースで取得してアンサンブル → DB 保存して返す。
   *  hours = 今日のこれから / hours_all = 保存した全時間帯 (今日 + 明日)。 */
  r.get('/api/weather/ensemble', async (c: Context) => {
    if (!featureEnabled(db, 'weather_enabled')) return c.json({ error: 'weather feature disabled' }, 404);
    const loc = resolveLocation(db, c);
    if (!loc) return c.json({ error: 'no location available' }, 400);
    const url = new URL(c.req.url);
    const label = url.searchParams.get('label');
    try {
      const res = await runAndStoreEnsemble(db, loc.lat, loc.lon, label);
      return c.json({
        snapshot_id: res.snapshotId,
        date: res.date,
        lat: res.lat, lon: res.lon, source: loc.source,
        agreement_threshold: res.agreementThreshold,
        sources: res.sources,
        hours: hoursForDay(res.hours, res.date),
        hours_all: res.hours,
      });
    } catch (e: unknown) {
      return c.json({ error: `ensemble failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
    }
  });

  /** 保存済みアンサンブルの一覧 (新しい順、 各 hours 込み)。 DB 表示用。 */
  r.get('/api/weather/ensemble/snapshots', (c: Context) => {
    const url = new URL(c.req.url);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
    return c.json({ snapshots: listEnsembleSnapshots(db, limit) });
  });

  /** 保存済みアンサンブル 1 件。 */
  r.get('/api/weather/ensemble/snapshot/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
    const snap = getEnsembleSnapshot(db, id);
    if (!snap) return c.json({ error: 'not found' }, 404);
    return c.json(snap);
  });

  /** 今日の対象地点 (自宅 + 行きがちな場所)。 likely 判定は blackbox 由来。 */
  r.get('/api/weather/targets', async (c: Context) => {
    if (!featureEnabled(db, 'weather_enabled')) return c.json({ error: 'weather feature disabled' }, 404);
    const targets = await resolveTargets(db, engine);
    return c.json({ targets });
  });

  /** 今日の雨ブリーフィングを即時生成 (送信せず返す)。 */
  r.get('/api/weather/briefing', async (c: Context) => {
    if (!featureEnabled(db, 'weather_enabled')) return c.json({ error: 'weather feature disabled' }, 404);
    try {
      const briefing = await buildBriefing(db, engine);
      return c.json(briefing);
    } catch (e: unknown) {
      return c.json({ error: `briefing failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
    }
  });

  /** ソースの有効/無効 + API キーの設定状況。 キー値そのものは返さない。 */
  r.get('/api/weather/sources', (c: Context) => {
    const cfg = getWeatherConfig(db);
    const enabled = new Set(cfg.enabledSourceIds);
    return c.json({
      sources: ALL_SOURCES.map((s) => ({
        id: s.id, label: s.label,
        enabled: enabled.has(s.id),
        available: s.isAvailable(cfg.ctx),
      })),
      has_openweathermap_key: !!cfg.ctx.openweathermapApiKey,
      has_weatherapi_key: !!cfg.ctx.weatherapiApiKey,
      agreement_threshold: cfg.agreementThreshold,
      briefing: cfg.briefing,
    });
  });

  r.patch('/api/weather/sources', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const patch: Record<string, string> = {};
    if (Array.isArray(body.enabled)) {
      const valid = new Set(ALL_SOURCES.map((s) => s.id));
      patch['weather.sources.enabled'] = body.enabled.filter((x): x is string => typeof x === 'string' && valid.has(x)).join(',');
    }
    if (typeof body.openweathermap_api_key === 'string') patch['weather.sources.openweathermap.api_key'] = body.openweathermap_api_key.trim();
    if (typeof body.weatherapi_api_key === 'string') patch['weather.sources.weatherapi.api_key'] = body.weatherapi_api_key.trim();
    if (typeof body.agreement_threshold === 'number') patch['weather.agreement_threshold'] = String(body.agreement_threshold);
    if (typeof body.briefing_hour === 'number') patch['weather.morning_briefing.hour'] = String(Math.round(body.briefing_hour));
    if (typeof body.briefing_enabled === 'boolean') patch['weather.morning_briefing.enabled'] = String(body.briefing_enabled);
    if (typeof body.notify_when_clear === 'boolean') patch['weather.morning_briefing.notify_when_clear'] = String(body.notify_when_clear);
    if (Object.keys(patch).length === 0) return c.json({ error: 'nothing to update' }, 400);
    setAppSettings(db, patch);
    return c.json({ ok: true });
  });

  return r;
}

// ── サマリ整形 ──────────────────────────────────────────────────────────

export interface WeatherSummary {
  date: string;
  icon: string;
  label: string;
  temp_max: number | null;
  temp_min: number | null;
  precipitation_sum: number | null;
  is_raining_now: boolean;
  /** これから雨が降り始める予想時刻 (ISO local)。 既に降っていれば null。 */
  next_rain_start: string | null;
}

export function summarize(f: Forecast, date: string): WeatherSummary {
  const idx = f.daily.time.indexOf(date);
  const code = idx >= 0 ? f.daily.weather_code[idx] : (f.current?.weather_code ?? 0);
  const desc = describeCode(code);
  const raining = isRainingNow(f);
  const next = raining ? null : nextRainStart(f, { todayDateLocal: date });
  return {
    date,
    icon: desc.icon,
    label: desc.label,
    temp_max: idx >= 0 ? f.daily.temperature_max[idx] ?? null : null,
    temp_min: idx >= 0 ? f.daily.temperature_min[idx] ?? null : null,
    precipitation_sum: idx >= 0 ? f.daily.precipitation_sum[idx] ?? null : null,
    is_raining_now: raining,
    next_rain_start: next,
  };
}
