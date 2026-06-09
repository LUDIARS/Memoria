// WeatherAPI.com forecast.json (無料枠)。 キー必須。 hourly に will_it_rain /
// chance_of_rain / precip_mm を持つので素直にマップできる。 time は地点 local。

import type { HourPoint, SourceContext, WeatherSource } from './types.js';
import { SOURCE_FETCH_TIMEOUT_MS } from './types.js';

const ENDPOINT = 'https://api.weatherapi.com/v1/forecast.json';

interface WApiHour {
  time: string;                        // "2026-06-09 14:00" (地点 local)
  will_it_rain?: number;               // 0|1
  chance_of_rain?: number;             // %
  precip_mm?: number;
  condition?: { text?: string };
}

interface WApiDay { hour?: WApiHour[]; }

function toHourIso(local: string): string {
  // "2026-06-09 14:00" → "2026-06-09T14:00"
  return local.replace(' ', 'T').slice(0, 16);
}

async function fetchWeatherApi(lat: number, lon: number, ctx: SourceContext): Promise<HourPoint[]> {
  const key = ctx.weatherapiApiKey;
  if (!key) throw new Error('weatherapi: api key not set');
  const params = new URLSearchParams({
    key, q: `${lat},${lon}`, days: '2', aqi: 'no', alerts: 'no',
  });
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, { signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`weatherapi: ${res.status} ${res.statusText}`);
  const raw = await res.json() as { forecast?: { forecastday?: WApiDay[] } };
  const days = raw.forecast?.forecastday ?? [];
  const out: HourPoint[] = [];
  for (const day of days) {
    for (const h of day.hour ?? []) {
      const precip = h.precip_mm ?? null;
      const pop = h.chance_of_rain ?? null;
      const willRain = h.will_it_rain === 1 || (precip != null && precip >= 0.1);
      out.push({ timeLocalIso: toHourIso(h.time), willRain, pop, precipMm: precip, label: h.condition?.text });
    }
  }
  return out;
}

export const weatherapiSource: WeatherSource = {
  id: 'weatherapi',
  label: 'WeatherAPI.com',
  isAvailable: (ctx) => !!ctx.weatherapiApiKey,
  fetch: fetchWeatherApi,
};
