// 日次集計の保存先 (Memoria の SQLite)。 1 日 1 行。 マージ件数とコミット件数は別々に上書きする。

import type BetterSqlite3 from 'better-sqlite3';
import type { DailyThroughput, MergeCount } from './types.js';

type Db = BetterSqlite3.Database;

interface Row {
  day: string;
  rv_merged: number;
  rv_by_repo: string;
  commits: number | null;
  collected_at: string;
}

export function ensureDevThroughputSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_throughput_daily (
      day          TEXT PRIMARY KEY,
      rv_merged    INTEGER NOT NULL DEFAULT 0,
      rv_by_repo   TEXT NOT NULL DEFAULT '{}',
      commits      INTEGER,
      collected_at TEXT NOT NULL
    )
  `);
}

export function saveMergeCount(db: Db, day: string, count: MergeCount, at: string): void {
  db.prepare(`
    INSERT INTO dev_throughput_daily (day, rv_merged, rv_by_repo, collected_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET rv_merged = excluded.rv_merged, rv_by_repo = excluded.rv_by_repo, collected_at = excluded.collected_at
  `).run(day, count.total, JSON.stringify(count.byRepo), at);
}

export function saveCommitCount(db: Db, day: string, commits: number, at: string): void {
  db.prepare(`
    INSERT INTO dev_throughput_daily (day, commits, collected_at) VALUES (?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET commits = excluded.commits, collected_at = excluded.collected_at
  `).run(day, commits, at);
}

function parseByRepo(value: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  } catch {
    return {};
  }
}

/** 指定した日の行を days の順で返す。 行の無い日は含めない。 */
export function listDaily(db: Db, days: readonly string[]): DailyThroughput[] {
  if (!days.length) return [];
  const rows = db.prepare(`SELECT * FROM dev_throughput_daily WHERE day IN (${days.map(() => '?').join(',')})`).all(...days) as Row[];
  const byDay = new Map(rows.map((row) => [row.day, row]));
  return days.flatMap((day) => {
    const row = byDay.get(day);
    return row ? [{ day, rvMerged: row.rv_merged, rvByRepo: parseByRepo(row.rv_by_repo), commits: row.commits, collectedAt: row.collected_at }] : [];
  });
}
