// Open-Meteo client + per-day weather snapshot storage.
//
// Open-Meteo は API key 不要・ 商用利用可・ JMA データもバックエンドで使うため
// 日本国内の精度が良い (https://open-meteo.com/)。 個人 PC 常駐 Memoria の
// 用途なら rate limit は事実上気にしなくて良い。
//
// 取り扱う forecast は:
//   - current:   現在の気温 / weather_code / 降水
//   - hourly:    今日 + 明日の hourly (rain 検知の 「今後 N 時間」 に使う)
//   - daily:     今日の最高/最低気温 / 降水量 / sunrise/sunset
//
// 「位置」 は呼び出し側が決める。 一番直近の GPS を使うのが既定だが、 GPS が
// 無い PC では設定で固定 lat/lon を入れられる。

import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

const OPEN_METEO_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const FETCH_TIMEOUT_MS = 15_000;

/** Open-Meteo の WMO weather code (= 0:晴れ / 1-3:雲 / 51+:雨 / 71+:雪 / etc) */
export type WeatherCode = number;

export interface CurrentWeather {
  time: string;                      // ISO with TZ
  temperature: number;               // ℃
  precipitation: number;             // mm
  weather_code: WeatherCode;
}

export interface HourlyWeather {
  /** ISO hour strings (timezone=auto なので local TZ) */
  time: string[];
  temperature: number[];
  precipitation: number[];
  precipitation_probability: number[];
  weather_code: WeatherCode[];
}

export interface DailyWeather {
  time: string[];                    // YYYY-MM-DD
  weather_code: WeatherCode[];
  temperature_max: number[];
  temperature_min: number[];
  precipitation_sum: number[];
  sunrise: string[];
  sunset: string[];
}

export interface Forecast {
  lat: number;
  lon: number;
  timezone: string;
  current: CurrentWeather | null;
  hourly: HourlyWeather;
  daily: DailyWeather;
}

/** Open-Meteo を叩いて生 JSON を Forecast に整形して返す。 */
export async function fetchForecast(lat: number, lon: number): Promise<Forecast> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,precipitation,weather_code',
    hourly: 'temperature_2m,precipitation,precipitation_probability,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,sunrise,sunset',
    timezone: 'auto',
    forecast_days: '2',
  });
  const url = `${OPEN_METEO_ENDPOINT}?${params.toString()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`open-meteo: ${res.status} ${res.statusText}`);
  const raw = await res.json() as OpenMeteoResponse;
  return normalize(raw, lat, lon);
}

// Open-Meteo 生レスポンスの shape (型付け用)
interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  current?: {
    time: string;
    temperature_2m: number;
    precipitation: number;
    weather_code: number;
  };
  hourly?: {
    time: string[];
    temperature_2m: number[];
    precipitation: number[];
    precipitation_probability: number[];
    weather_code: number[];
  };
  daily?: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_sum: number[];
    sunrise: string[];
    sunset: string[];
  };
}

function normalize(raw: OpenMeteoResponse, lat: number, lon: number): Forecast {
  return {
    lat,
    lon,
    timezone: raw.timezone || 'UTC',
    current: raw.current ? {
      time: raw.current.time,
      temperature: raw.current.temperature_2m,
      precipitation: raw.current.precipitation,
      weather_code: raw.current.weather_code,
    } : null,
    hourly: {
      time: raw.hourly?.time ?? [],
      temperature: raw.hourly?.temperature_2m ?? [],
      precipitation: raw.hourly?.precipitation ?? [],
      precipitation_probability: raw.hourly?.precipitation_probability ?? [],
      weather_code: raw.hourly?.weather_code ?? [],
    },
    daily: {
      time: raw.daily?.time ?? [],
      weather_code: raw.daily?.weather_code ?? [],
      temperature_max: raw.daily?.temperature_2m_max ?? [],
      temperature_min: raw.daily?.temperature_2m_min ?? [],
      precipitation_sum: raw.daily?.precipitation_sum ?? [],
      sunrise: raw.daily?.sunrise ?? [],
      sunset: raw.daily?.sunset ?? [],
    },
  };
}

// ── 雨判定 ────────────────────────────────────────────────────────────────
//
// WMO weather code リファレンス:
//   51, 53, 55: 霧雨 (light/moderate/dense drizzle)
//   56, 57:     凍る霧雨
//   61, 63, 65: 雨 (slight/moderate/heavy)
//   66, 67:     凍る雨
//   80, 81, 82: にわか雨
//   95, 96, 99: 雷雨
// 「降水を伴うコード」 をひとまとめに判定する。 雪 (71+) は別扱い。

export function codeIsRain(code: WeatherCode): boolean {
  return (
    (code >= 51 && code <= 67)
    || (code >= 80 && code <= 82)
    || (code >= 95 && code <= 99)
  );
}

export function codeIsSnow(code: WeatherCode): boolean {
  return (code >= 71 && code <= 77) || code === 85 || code === 86;
}

/** WMO code → 絵文字 + 日本語ラベル */
export function describeCode(code: WeatherCode): { icon: string; label: string } {
  if (code === 0) return { icon: '☀️', label: '快晴' };
  if (code === 1) return { icon: '🌤', label: 'おおむね晴れ' };
  if (code === 2) return { icon: '⛅', label: '一部曇り' };
  if (code === 3) return { icon: '☁️', label: '曇り' };
  if (code === 45 || code === 48) return { icon: '🌫', label: '霧' };
  if (code >= 51 && code <= 57) return { icon: '🌦', label: '霧雨' };
  if (code >= 61 && code <= 67) return { icon: '🌧', label: '雨' };
  if (codeIsSnow(code)) return { icon: '🌨', label: '雪' };
  if (code >= 80 && code <= 82) return { icon: '🌧', label: 'にわか雨' };
  if (code >= 95 && code <= 99) return { icon: '⛈', label: '雷雨' };
  return { icon: '🌡', label: `code ${code}` };
}

/**
 * 「今日 (= 現在以降の本日中) に雨が降る予報か」 を判定。
 * 戻り値: 雨が始まる予想時刻 (ISO) or null。
 *
 * 「日中に晴れ→雨」 用に start 時刻を返す。 既に降っていたら start = now。
 */
export function nextRainStart(
  forecast: Forecast,
  opts: { todayDateLocal: string; probabilityThreshold?: number; lookAheadHours?: number } = { todayDateLocal: '' },
): string | null {
  const { todayDateLocal } = opts;
  const probTh = opts.probabilityThreshold ?? 50;       // %
  const lookAhead = opts.lookAheadHours ?? 12;          // 今日いっぱい見たいので長め
  const now = Date.now();
  const horizon = now + lookAhead * 60 * 60 * 1000;
  const times = forecast.hourly.time;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    // timezone=auto なら ISO (offset 無し / TZ-implicit) で返ってくるので
    // local TZ として Date 解釈する。 Open-Meteo は "2026-05-14T09:00" 形式。
    const ts = new Date(t).getTime();
    if (Number.isNaN(ts)) continue;
    if (ts < now - 30 * 60 * 1000) continue;             // 30 分以上過去は無視
    if (ts > horizon) break;
    if (todayDateLocal && !t.startsWith(todayDateLocal)) continue;
    const code = forecast.hourly.weather_code[i] ?? 0;
    const prob = forecast.hourly.precipitation_probability[i] ?? 0;
    const precip = forecast.hourly.precipitation[i] ?? 0;
    if (codeIsRain(code) || precip >= 0.5 || prob >= probTh) {
      return t;
    }
  }
  return null;
}

/** 「今 (= current) の段階で既に降っているか」 (= 「降っている / 降りそう」 判定の境界) */
export function isRainingNow(forecast: Forecast): boolean {
  const c = forecast.current;
  if (!c) return false;
  return codeIsRain(c.weather_code) || c.precipitation >= 0.1;
}

// ── DB snapshot 保存 ────────────────────────────────────────────────────

export interface WeatherSnapshotRow {
  id: number;
  fetched_at: number;
  date: string;
  lat: number;
  lon: number;
  current_json: string | null;
  hourly_json: string | null;
  daily_json: string | null;
}

/** 1 行 = 1 回の fetch。 同じ date に何度 fetch しても上書きせず append。
 *  日記生成では 「その date の最新行」 を読む。 */
export function insertWeatherSnapshot(db: Db, date: string, f: Forecast): number {
  const stmt = db.prepare(
    `INSERT INTO weather_snapshots (fetched_at, date, lat, lon, current_json, hourly_json, daily_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(
    Date.now(),
    date,
    f.lat,
    f.lon,
    f.current ? JSON.stringify(f.current) : null,
    JSON.stringify(f.hourly),
    JSON.stringify(f.daily),
  );
  return Number(info.lastInsertRowid);
}

/** date の最新 snapshot (= 一番最近 fetch した行) を返す。 */
export function getLatestSnapshotForDate(db: Db, date: string): WeatherSnapshotRow | null {
  const row = db.prepare(
    `SELECT * FROM weather_snapshots WHERE date = ? ORDER BY fetched_at DESC LIMIT 1`,
  ).get(date) as WeatherSnapshotRow | undefined;
  return row ?? null;
}

/** 全 date のうち一番新しい snapshot (= 「直近の天気」 用)。 */
export function getMostRecentSnapshot(db: Db): WeatherSnapshotRow | null {
  const row = db.prepare(
    `SELECT * FROM weather_snapshots ORDER BY fetched_at DESC LIMIT 1`,
  ).get() as WeatherSnapshotRow | undefined;
  return row ?? null;
}

/** snapshot row を Forecast に戻す (current/hourly/daily JSON を parse)。 */
export function rowToForecast(row: WeatherSnapshotRow): Forecast {
  return {
    lat: row.lat,
    lon: row.lon,
    timezone: 'auto',
    current: row.current_json ? JSON.parse(row.current_json) as CurrentWeather : null,
    hourly: row.hourly_json
      ? JSON.parse(row.hourly_json) as HourlyWeather
      : { time: [], temperature: [], precipitation: [], precipitation_probability: [], weather_code: [] },
    daily: row.daily_json
      ? JSON.parse(row.daily_json) as DailyWeather
      : { time: [], weather_code: [], temperature_max: [], temperature_min: [], precipitation_sum: [], sunrise: [], sunset: [] },
  };
}

/** 直近の GPS 1 点 (= /api/locations/latest と同じ) から lat/lon を取る。
 *  GPS が無ければ null。 設定で固定 lat/lon が入っていればそちらを優先 (= 呼び出し側で判断)。 */
export function readLatestGpsLatLon(db: Db): { lat: number; lon: number } | null {
  const row = db.prepare(
    `SELECT lat, lon FROM gps_locations ORDER BY recorded_at DESC LIMIT 1`,
  ).get() as { lat: number; lon: number } | undefined;
  if (!row) return null;
  return { lat: row.lat, lon: row.lon };
}
