// マルチソース・アンサンブルの永続化。 都度計算していたアンサンブル結果を
// weather_ensemble_snapshots に 1 fetch = 1 行で保存し、 後から閲覧できるようにする。
// テーブル定義は db.ts (spec/data/weather.md)。

import type BetterSqlite3 from 'better-sqlite3';
import type { EnsembleHour } from './ensemble.js';

type Db = BetterSqlite3.Database;

/** 保存時のソース内訳 (どのソースが成功/失敗したか)。 */
export interface EnsembleSourceStat {
  id: string;
  ok: boolean;
  error: string | null;
  points: number;
}

export interface EnsembleSnapshotRow {
  id: number;
  fetched_at: number;
  date: string;
  lat: number;
  lon: number;
  label: string | null;
  agreement_threshold: number;
  sources_json: string;
  hours_json: string;
}

export interface EnsembleSnapshot {
  id: number;
  fetched_at: number;
  date: string;
  lat: number;
  lon: number;
  label: string | null;
  agreement_threshold: number;
  sources: EnsembleSourceStat[];
  hours: EnsembleHour[];
}

export interface InsertEnsembleArgs {
  date: string;
  lat: number;
  lon: number;
  label: string | null;
  agreementThreshold: number;
  sources: EnsembleSourceStat[];
  hours: EnsembleHour[];
}

export function insertEnsembleSnapshot(db: Db, a: InsertEnsembleArgs): number {
  const info = db.prepare(
    `INSERT INTO weather_ensemble_snapshots
       (fetched_at, date, lat, lon, label, agreement_threshold, sources_json, hours_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(), a.date, a.lat, a.lon, a.label, a.agreementThreshold,
    JSON.stringify(a.sources), JSON.stringify(a.hours),
  );
  return Number(info.lastInsertRowid);
}

function rowToSnapshot(r: EnsembleSnapshotRow): EnsembleSnapshot {
  return {
    id: r.id, fetched_at: r.fetched_at, date: r.date, lat: r.lat, lon: r.lon,
    label: r.label, agreement_threshold: r.agreement_threshold,
    sources: r.sources_json ? JSON.parse(r.sources_json) as EnsembleSourceStat[] : [],
    hours: r.hours_json ? JSON.parse(r.hours_json) as EnsembleHour[] : [],
  };
}

/** 保存済みアンサンブルの一覧 (新しい順)。 中身 (hours) も含めて返す。 */
export function listEnsembleSnapshots(db: Db, limit = 30): EnsembleSnapshot[] {
  const rows = db.prepare(
    `SELECT * FROM weather_ensemble_snapshots ORDER BY fetched_at DESC LIMIT ?`,
  ).all(limit) as EnsembleSnapshotRow[];
  return rows.map(rowToSnapshot);
}

export function getEnsembleSnapshot(db: Db, id: number): EnsembleSnapshot | null {
  const row = db.prepare(`SELECT * FROM weather_ensemble_snapshots WHERE id = ?`).get(id) as EnsembleSnapshotRow | undefined;
  return row ? rowToSnapshot(row) : null;
}
