// 天気ソース。 既存の Open-Meteo クライアント (lib/weather.ts) の Forecast から
// 「現在地の天気」 と「これから 3 時間の天気」 の 2 ブロックを作る。
// fetch は compose 側で 1 回だけ行い、 その Forecast を使い回す。

import type { SectionBlock } from '../types.js';
import { describeCode, type Forecast } from '../../lib/weather.js';

const AHEAD_HOURS = 3;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 現在地の天気ブロック。 */
export function buildCurrentWeatherBlock(forecast: Forecast): SectionBlock {
  const c = forecast.current;
  if (!c) {
    return { key: 'weather_now', heading: '📍 現在地の天気', lines: ['（現在の天気を取得できませんでした）'] };
  }
  const d = describeCode(c.weather_code);
  return {
    key: 'weather_now',
    heading: '📍 現在地の天気',
    lines: [`${d.icon} ${d.label}　${Math.round(c.temperature)}℃　降水 ${c.precipitation.toFixed(1)}mm`],
  };
}

/** これから 3 時間の hourly 天気ブロック。 */
export function buildNext3hWeatherBlock(forecast: Forecast): SectionBlock {
  const { time, temperature, precipitation_probability, weather_code } = forecast.hourly;
  const now = Date.now();
  // 現在時刻以降で最初の hourly index を探す (timezone=auto のローカル ISO)。
  let start = time.findIndex((t) => {
    const ts = new Date(t).getTime();
    return Number.isFinite(ts) && ts >= now - 30 * 60 * 1000;
  });
  if (start < 0) start = 0;

  const lines: string[] = [];
  for (let i = start; i < time.length && lines.length < AHEAD_HOURS; i++) {
    const t = new Date(time[i]);
    if (Number.isNaN(t.getTime())) continue;
    const d = describeCode(weather_code[i] ?? 0);
    const temp = temperature[i];
    const prob = precipitation_probability[i];
    const tempStr = Number.isFinite(temp) ? `${Math.round(temp)}℃` : '--';
    const probStr = Number.isFinite(prob) ? `☔${prob}%` : '';
    lines.push(`${pad2(t.getHours())}時　${d.icon} ${d.label}　${tempStr}　${probStr}`.trimEnd());
  }
  if (!lines.length) lines.push('（時間別予報を取得できませんでした）');
  return { key: 'weather_3h', heading: '🕒 これから3時間の天気', lines };
}
