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
import { getAppSettings } from '../db.js';
import { featureEnabled } from '../lib/privacy.js';

type Db = BetterSqlite3.Database;

export interface WeatherRouterDeps { db: Db }

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
  const { db } = deps;
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
