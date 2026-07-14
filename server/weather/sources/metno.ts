// MET Norway (met.no) locationforecast 2.0 compact。 完全独立モデル・キー不要だが
// User-Agent (連絡先付き) が必須。 時刻は UTC で返るので local hour ISO に変換する。

import type { HourPoint, SourceContext, WeatherSource } from './types.js';
import { SOURCE_FETCH_TIMEOUT_MS } from './types.js';

const ENDPOINT = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';

interface MetnoTimestep {
  time: string;                       // UTC ISO ("2026-06-09T05:00:00Z")
  data?: {
    next_1_hours?: {
      summary?: { symbol_code?: string };
      details?: { precipitation_amount?: number; probability_of_precipitation?: number };
    };
  };
}

/** UTC ISO を server-local の "YYYY-MM-DDTHH:00" に丸める。 */
function toLocalHourIso(utcIso: string): string {
  const d = new Date(utcIso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
}

function symbolIsRain(symbol: string | undefined): boolean {
  if (!symbol) return false;
  return /rain|sleet|drizzle|thunder/.test(symbol);
}

async function fetchMetno(lat: number, lon: number, ctx: SourceContext): Promise<HourPoint[]> {
  const url = `${ENDPOINT}?lat=${lat}&lon=${lon}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': ctx.userAgent },
    signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`met.no: ${res.status} ${res.statusText}`);
  const raw = await res.json() as { properties?: { timeseries?: MetnoTimestep[] } };
  const series = raw.properties?.timeseries ?? [];
  const out: HourPoint[] = [];
  for (const step of series) {
    const n1 = step.data?.next_1_hours;
    if (!n1) continue;                  // next_1_hours が無い遠未来は粗いので捨てる
    const symbol = n1.summary?.symbol_code;
    const precip = n1.details?.precipitation_amount ?? null;
    const pop = n1.details?.probability_of_precipitation ?? null;
    const willRain = symbolIsRain(symbol) || (precip != null && precip >= 0.1);
    out.push({ timeLocalIso: toLocalHourIso(step.time), willRain, pop, precipMm: precip, label: symbol });
  }
  return out;
}

export const metnoSource: WeatherSource = {
  id: 'metno',
  label: 'MET Norway',
  isAvailable: () => true,
  fetch: fetchMetno,
};
