// Open-Meteo ソース。 1 プロバイダだが models= を変えて独立した予報モデルを得る。
// ECMWF / GFS / ICON / JMA をそれぞれ別ソース扱いにする (キー不要)。

import { codeIsRain } from '../../lib/weather.js';
import type { HourPoint, SourceContext, WeatherSource } from './types.js';
import { SOURCE_FETCH_TIMEOUT_MS } from './types.js';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

interface OpenMeteoHourly {
  time?: string[];
  precipitation?: Array<number | null>;
  precipitation_probability?: Array<number | null>;
  weather_code?: Array<number | null>;
}

interface ModelSpec { id: string; label: string; model: string; }

const MODELS: ModelSpec[] = [
  { id: 'open-meteo-ecmwf', label: 'Open-Meteo (ECMWF)', model: 'ecmwf_ifs04' },
  { id: 'open-meteo-gfs', label: 'Open-Meteo (GFS)', model: 'gfs_seamless' },
  { id: 'open-meteo-icon', label: 'Open-Meteo (ICON)', model: 'icon_seamless' },
  { id: 'open-meteo-jma', label: 'Open-Meteo (気象庁)', model: 'jma_seamless' },
];

async function fetchModel(lat: number, lon: number, model: string): Promise<HourPoint[]> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: 'precipitation,precipitation_probability,weather_code',
    timezone: 'auto',
    forecast_days: '2',
    models: model,
  });
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, { signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`open-meteo(${model}): ${res.status} ${res.statusText}`);
  const raw = await res.json() as { hourly?: OpenMeteoHourly };
  const h = raw.hourly ?? {};
  const times = h.time ?? [];
  return times.map((t, i) => {
    const code = h.weather_code?.[i] ?? null;
    const precip = h.precipitation?.[i] ?? null;
    const pop = h.precipitation_probability?.[i] ?? null;
    const willRain = (code != null && codeIsRain(code)) || (precip != null && precip >= 0.1);
    return { timeLocalIso: t, willRain, pop: pop ?? null, precipMm: precip ?? null };
  });
}

export const openMeteoSources: WeatherSource[] = MODELS.map((m) => ({
  id: m.id,
  label: m.label,
  isAvailable: () => true,
  fetch: (lat: number, lon: number, _ctx: SourceContext) => fetchModel(lat, lon, m.model),
}));
