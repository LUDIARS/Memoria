// 全ソース取得 → アンサンブル集約 → DB 保存 を 1 関数にまとめる。
// route と scheduler の両方から呼び、 「全API のアンサンブル天気予報」 を
// weather_ensemble_snapshots に必ず残す。

import type BetterSqlite3 from 'better-sqlite3';
import { getWeatherConfig } from './config.js';
import { runEnabledSources } from './sources/index.js';
import { aggregate, type EnsembleHour } from './ensemble.js';
import { insertEnsembleSnapshot, type EnsembleSourceStat } from './ensemble-store.js';

type Db = BetterSqlite3.Database;

export interface EnsembleResult {
  snapshotId: number;
  date: string;
  lat: number;
  lon: number;
  label: string | null;
  agreementThreshold: number;
  sources: EnsembleSourceStat[];
  hours: EnsembleHour[];          // 全時間帯 (今日 + 明日)
}

function localDate(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 1 地点を全有効ソースで取得 → アンサンブル → DB 保存して結果を返す。 */
export async function runAndStoreEnsemble(
  db: Db, lat: number, lon: number, label: string | null = null, now = new Date(),
): Promise<EnsembleResult> {
  const cfg = getWeatherConfig(db);
  const forecasts = await runEnabledSources(lat, lon, cfg.ctx, cfg.enabledSourceIds);
  const hours = aggregate(forecasts);                  // 全時間帯を保存 (絞らない)
  const sources: EnsembleSourceStat[] = forecasts.map((f) => ({
    id: f.sourceId, ok: f.ok, error: f.error ?? null, points: f.points.length,
  }));
  const date = localDate(now);
  const snapshotId = insertEnsembleSnapshot(db, {
    date, lat, lon, label, agreementThreshold: cfg.agreementThreshold, sources, hours,
  });
  return { snapshotId, date, lat, lon, label, agreementThreshold: cfg.agreementThreshold, sources, hours };
}
