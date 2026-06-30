// プラグインフレームワークの本体側ストア。
//
// プラグインが参照する host 機能 (Discord通知 / GPS / 日記出力 / 傾向出力) を
// Memoria 本体の SQLite + Discord に結線する。 ここが「capability の実装」 で、
// submodule 側 (host/capabilities.ts) はインターフェースのみを定義する。
//
//  - 日記出力 (recordDiary): plugin_diary_entries に日付付きで貯める。
//    diary.ts がその日の記事生成時に読み込み、 narration に織り込む。
//  - 傾向出力 (recordTrend): plugin_trends に系列値を貯める。 /api/plugins/trends で
//    取り出し UI がグラフ化する。
//  - GPS (latestGps): gps_locations の最新行。
//  - announce: 本体 discord notifier (announceToDiscord)。

import type BetterSqlite3 from 'better-sqlite3';
import type {
  CapabilityProviders,
  DiaryContribution,
  GpsFix,
  TrendPoint,
} from './memoria-plugin/host/capabilities.js';
import { announceToDiscord } from '../discord/index.js';

type Db = BetterSqlite3.Database;

/** plugin_diary_entries の 1 行 (diary.ts が読む)。 */
export interface PluginDiaryEntryRow {
  plugin_id: string;
  date: string;
  summary: string;
  data_json: string | null;
  created_at: string;
}

/** plugin_trends の 1 行 (傾向グラフ用)。 */
export interface PluginTrendRow {
  plugin_id: string;
  series: string;
  value: number;
  unit: string | null;
  at: string;
}

/** フレームワーク共有テーブルを冪等に用意する。 */
export function ensureFrameworkTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_diary_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_id TEXT NOT NULL,
      date TEXT NOT NULL,
      summary TEXT NOT NULL,
      data_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plugin_diary_date ON plugin_diary_entries(date);

    CREATE TABLE IF NOT EXISTS plugin_trends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_id TEXT NOT NULL,
      series TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plugin_trends_lookup ON plugin_trends(plugin_id, series, at);
  `);
}

/** ローカル日付 YYYY-MM-DD。 diary が日付単位で集約するため local 基準。 */
function todayLocal(): string {
  return new Date().toLocaleDateString('en-CA'); // → "2026-06-30"
}

function nowIso(): string {
  return new Date().toISOString();
}

/** capability の本体実装を組む。 buildRegistry に渡す。 */
export function createCapabilityProviders(db: Db): CapabilityProviders {
  const insertDiary = db.prepare(
    `INSERT INTO plugin_diary_entries (plugin_id, date, summary, data_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertTrend = db.prepare(
    `INSERT INTO plugin_trends (plugin_id, series, value, unit, at) VALUES (?, ?, ?, ?, ?)`,
  );
  const latestGpsStmt = db.prepare(
    `SELECT lat, lon, recorded_at FROM gps_locations ORDER BY recorded_at DESC LIMIT 1`,
  );

  return {
    announce: (text: string) => announceToDiscord(db, text),
    latestGps: (): GpsFix | null => {
      const row = latestGpsStmt.get() as
        | { lat: number; lon: number; recorded_at: string | null }
        | undefined;
      if (!row) return null;
      return { lat: row.lat, lon: row.lon, recordedAt: row.recorded_at ?? null };
    },
    recordDiary: (pluginId: string, c: DiaryContribution): void => {
      const date = c.date ?? todayLocal();
      const dataJson = c.data === undefined ? null : JSON.stringify(c.data);
      insertDiary.run(pluginId, date, c.summary, dataJson, nowIso());
    },
    recordTrend: (pluginId: string, p: TrendPoint): void => {
      insertTrend.run(pluginId, p.series, p.value, p.unit ?? null, p.at ?? nowIso());
    },
  };
}

/** ある日付のプラグイン日記寄稿を読む (diary.ts が記事生成時に使う)。 */
export function listPluginDiaryEntries(db: Db, date: string): PluginDiaryEntryRow[] {
  return db
    .prepare(
      `SELECT plugin_id, date, summary, data_json, created_at
         FROM plugin_diary_entries WHERE date = ? ORDER BY created_at ASC`,
    )
    .all(date) as PluginDiaryEntryRow[];
}

export interface TrendQuery {
  pluginId: string;
  series?: string;
  sinceIso?: string;
  limit?: number;
}

/** 傾向系列を取り出す (UI グラフ用)。 */
export function listPluginTrends(db: Db, q: TrendQuery): PluginTrendRow[] {
  const where: string[] = ['plugin_id = ?'];
  const params: unknown[] = [q.pluginId];
  if (q.series) {
    where.push('series = ?');
    params.push(q.series);
  }
  if (q.sinceIso) {
    where.push('at >= ?');
    params.push(q.sinceIso);
  }
  const limit = Math.min(Math.max(q.limit ?? 500, 1), 5000);
  return db
    .prepare(
      `SELECT plugin_id, series, value, unit, at FROM plugin_trends
        WHERE ${where.join(' AND ')} ORDER BY at ASC LIMIT ?`,
    )
    .all(...params, limit) as PluginTrendRow[];
}

/** あるプラグインの系列名一覧 (UI のグラフ選択用)。 */
export function listPluginTrendSeries(db: Db, pluginId: string): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT series FROM plugin_trends WHERE plugin_id = ? ORDER BY series`)
    .all(pluginId) as { series: string }[];
  return rows.map((r) => r.series);
}
