// OpenWeatherMap 5 day / 3 hour forecast (無料枠)。 キー必須。
// weather[].id で降水判定 (2xx 雷 / 3xx 霧雨 / 5xx 雨)、 pop は 0..1 → %。

import type { HourPoint, SourceContext, WeatherSource } from './types.js';
import { SOURCE_FETCH_TIMEOUT_MS } from './types.js';

const ENDPOINT = 'https://api.openweathermap.org/data/2.5/forecast';

interface OwmEntry {
  dt: number;                          // unix seconds UTC
  pop?: number;                        // 0..1
  rain?: { '3h'?: number };
  weather?: Array<{ id?: number; description?: string }>;
}

function idIsRain(id: number | undefined): boolean {
  if (id == null) return false;
  // 2xx thunderstorm, 3xx drizzle, 5xx rain. 6xx snow は雨扱いしない。
  return (id >= 200 && id < 600);
}

function toLocalHourIso(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
}

async function fetchOwm(lat: number, lon: number, ctx: SourceContext): Promise<HourPoint[]> {
  const key = ctx.openweathermapApiKey;
  if (!key) throw new Error('openweathermap: api key not set');
  const params = new URLSearchParams({
    lat: String(lat), lon: String(lon), appid: key, units: 'metric',
  });
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, { signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`openweathermap: ${res.status} ${res.statusText}`);
  const raw = await res.json() as { list?: OwmEntry[] };
  const list = raw.list ?? [];
  return list.map((e) => {
    const id = e.weather?.[0]?.id;
    const precip = e.rain?.['3h'] ?? null;
    const pop = e.pop != null ? Math.round(e.pop * 100) : null;
    const willRain = idIsRain(id) || (precip != null && precip >= 0.1);
    return {
      timeLocalIso: toLocalHourIso(e.dt),
      willRain, pop, precipMm: precip,
      label: e.weather?.[0]?.description,
    };
  });
}

export const openweathermapSource: WeatherSource = {
  id: 'openweathermap',
  label: 'OpenWeatherMap',
  isAvailable: (ctx) => !!ctx.openweathermapApiKey,
  fetch: fetchOwm,
};
