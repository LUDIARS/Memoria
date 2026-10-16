import type BetterSqlite3 from 'better-sqlite3';

// Versioned cache: change the table version when the shared file classification changes.
export function ensureCodeAdditionsSchema(db: BetterSqlite3.Database): void {
  const columns = db.pragma('table_info(dev_throughput_daily)') as { name: string }[];
  if (!columns.some((column) => column.name === 'code_additions')) {
    db.exec('ALTER TABLE dev_throughput_daily ADD COLUMN code_additions INTEGER');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS dev_throughput_code_cache_v1 (
    repo TEXT NOT NULL, sha TEXT NOT NULL, additions INTEGER NOT NULL,
    PRIMARY KEY (repo, sha)
  )`);
}

export function readCodeCache(db: BetterSqlite3.Database, repo: string, sha: string): number | undefined {
  return (db.prepare('SELECT additions FROM dev_throughput_code_cache_v1 WHERE repo = ? AND sha = ?').get(repo, sha) as { additions: number } | undefined)?.additions;
}

export function saveCodeCache(db: BetterSqlite3.Database, repo: string, sha: string, additions: number): void {
  db.prepare('INSERT OR REPLACE INTO dev_throughput_code_cache_v1 (repo, sha, additions) VALUES (?, ?, ?)').run(repo, sha, additions);
}

export function saveCodeAdditions(db: BetterSqlite3.Database, day: string, additions: number, at: string): void {
  db.prepare(`INSERT INTO dev_throughput_daily (day, code_additions, collected_at) VALUES (?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET code_additions = excluded.code_additions, collected_at = excluded.collected_at`).run(day, additions, at);
}
