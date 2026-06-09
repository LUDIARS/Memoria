// 環境ソース。 Open-Meteo Air Quality API (API キー不要) から PM2.5 / AQI / UV /
// 花粉を取得する。 https://air-quality-api.open-meteo.com/v1/air-quality
//
// 花粉 (grass/birch/...) は CAMS Europe ドメインのみ提供で、 日本では null になる。
// その場合は花粉行を出さない。 PM2.5 / AQI / UV は全球で取得できる。

import type { SectionBlock } from '../types.js';

const AQ_ENDPOINT = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const FETCH_TIMEOUT_MS = 12_000;
const HEADING = '🌫 空気質・紫外線';

interface AqCurrent {
  pm2_5?: number | null;
  pm10?: number | null;
  european_aqi?: number | null;
  uv_index?: number | null;
  grass_pollen?: number | null;
  birch_pollen?: number | null;
  ragweed_pollen?: number | null;
}

/** European AQI バンド → 日本語ラベル。 */
function aqiLabel(aqi: number): string {
  if (aqi <= 20) return '良い';
  if (aqi <= 40) return 'まずまず';
  if (aqi <= 60) return 'やや悪い';
  if (aqi <= 80) return '悪い';
  if (aqi <= 100) return '非常に悪い';
  return '極めて悪い';
}

/** UV index → 日本語ラベル。 */
function uvLabel(uv: number): string {
  if (uv < 3) return '弱い';
  if (uv < 6) return '中程度';
  if (uv < 8) return '強い';
  if (uv < 11) return '非常に強い';
  return '極端';
}

export async function buildEnvironmentBlock(lat: number, lon: number): Promise<SectionBlock> {
  try {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current: 'pm2_5,pm10,european_aqi,uv_index,grass_pollen,birch_pollen,ragweed_pollen',
      timezone: 'auto',
    });
    const res = await fetch(`${AQ_ENDPOINT}?${params.toString()}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`air-quality: ${res.status} ${res.statusText}`);
    const raw = await res.json() as { current?: AqCurrent };
    const c = raw.current;
    if (!c) throw new Error('air-quality: no current data');

    const lines: string[] = [];
    if (c.european_aqi != null) {
      const pm = c.pm2_5 != null ? `　PM2.5 ${Math.round(c.pm2_5)}µg/m³` : '';
      lines.push(`大気質 AQI ${Math.round(c.european_aqi)}（${aqiLabel(c.european_aqi)}）${pm}`);
    } else if (c.pm2_5 != null) {
      lines.push(`PM2.5 ${Math.round(c.pm2_5)}µg/m³`);
    }
    if (c.uv_index != null) {
      lines.push(`UV指数 ${c.uv_index.toFixed(1)}（${uvLabel(c.uv_index)}）`);
    }
    // 花粉は日本では null。 取れた場合だけ載せる。
    const pollens: string[] = [];
    if (c.grass_pollen != null) pollens.push(`イネ科 ${Math.round(c.grass_pollen)}`);
    if (c.birch_pollen != null) pollens.push(`シラカバ ${Math.round(c.birch_pollen)}`);
    if (c.ragweed_pollen != null) pollens.push(`ブタクサ ${Math.round(c.ragweed_pollen)}`);
    if (pollens.length) lines.push(`花粉 ${pollens.join('・')}（粒/m³）`);

    if (!lines.length) lines.push('（環境データを取得できませんでした）');
    return { key: 'environment', heading: HEADING, lines };
  } catch (e: unknown) {
    return { key: 'environment', heading: HEADING, lines: [`⚠️ 取得失敗（${e instanceof Error ? e.message : String(e)}）`] };
  }
}
