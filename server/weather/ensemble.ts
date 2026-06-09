// マルチソースの時刻別アンサンブル。 各ソースの hourly を 1 時間バケットに
// 突き合わせ、 「何ソース中何ソースが雨か」 (agreement) を出す。 これが
// 「複数サイトで検証」 の実体。 雨の最終判定は blackbox (domains.ts) が下す。

import type { SourceForecast } from './sources/types.js';

/** 1 時間バケットの集計。 */
export interface EnsembleHour {
  /** "YYYY-MM-DDTHH:00" (local)。 */
  hour: string;
  votesRain: number;
  votesTotal: number;
  /** votesRain / votesTotal (0..1)。 */
  agreement: number;
  /** 降水確率の平均 (持つソースのみ)。 null = 誰も pop を持たない。 */
  avgPop: number | null;
  /** 降水量の最大 (mm)。 */
  maxPrecipMm: number | null;
  /** 雨と言ったソース id。 */
  agreeSources: string[];
}

/** "...THH:MM" → "...THH:00" に丸める。 */
function hourKey(iso: string): string {
  return iso.slice(0, 13) + ':00';
}

/** SourceForecast[] を時刻バケットごとに集計し、 hour 昇順で返す。 */
export function aggregate(forecasts: SourceForecast[]): EnsembleHour[] {
  interface Acc { rain: number; total: number; popSum: number; popN: number; maxPrecip: number | null; agree: string[]; }
  const buckets = new Map<string, Acc>();

  for (const f of forecasts) {
    if (!f.ok) continue;
    for (const p of f.points) {
      const key = hourKey(p.timeLocalIso);
      let acc = buckets.get(key);
      if (!acc) { acc = { rain: 0, total: 0, popSum: 0, popN: 0, maxPrecip: null, agree: [] }; buckets.set(key, acc); }
      acc.total += 1;
      if (p.willRain) { acc.rain += 1; acc.agree.push(f.sourceId); }
      if (p.pop != null) { acc.popSum += p.pop; acc.popN += 1; }
      if (p.precipMm != null) acc.maxPrecip = Math.max(acc.maxPrecip ?? 0, p.precipMm);
    }
  }

  return [...buckets.entries()]
    .map(([hour, a]): EnsembleHour => ({
      hour,
      votesRain: a.rain,
      votesTotal: a.total,
      agreement: a.total > 0 ? a.rain / a.total : 0,
      avgPop: a.popN > 0 ? Math.round(a.popSum / a.popN) : null,
      maxPrecipMm: a.maxPrecip,
      agreeSources: a.agree,
    }))
    .sort((x, y) => (x.hour < y.hour ? -1 : x.hour > y.hour ? 1 : 0));
}

/** date ("YYYY-MM-DD") かつ now 以降の時間帯に絞る。 */
export function hoursForDay(hours: EnsembleHour[], date: string, now = new Date()): EnsembleHour[] {
  const nowMs = now.getTime() - 30 * 60 * 1000;     // 30 分前まで許容
  return hours.filter((h) => {
    if (!h.hour.startsWith(date)) return false;
    const ts = new Date(h.hour).getTime();
    return !Number.isNaN(ts) && ts >= nowMs;
  });
}

/** 一致率 >= threshold で最初に雨になる時間帯 (= 雨の降り始め予想)。 */
export function rainOnset(hours: EnsembleHour[], threshold: number): EnsembleHour | null {
  for (const h of hours) {
    if (h.agreement >= threshold) return h;
  }
  return null;
}
