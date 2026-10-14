// trend_snapshots / trend_items の読み書き。 業務判断 (動きの判定など) は movement.ts に置き、 ここは SQL だけ。

import type BetterSqlite3 from 'better-sqlite3';
import { trendKey } from './movement.js';
import type { RawTrendItem, TrendGenre } from './types.js';

type Db = BetterSqlite3.Database;

export interface SnapshotInput {
  sourceId: string;
  genre: TrendGenre;
  fetchedAt: string;
  ok: boolean;
  error: string | null;
  items: RawTrendItem[];
}

export interface StoredSnapshot {
  id: number;
  fetchedAt: string;
  items: (RawTrendItem & { key: string })[];
}

export interface SnapshotAttempt {
  fetchedAt: string;
  ok: boolean;
  error: string | null;
}

export function recordSnapshot(db: Db, input: SnapshotInput): number {
  const insertSnapshot = db.prepare(
    'INSERT INTO trend_snapshots (source_id, genre, fetched_at, ok, error) VALUES (?, ?, ?, ?, ?)',
  );
  const insertItem = db.prepare(
    'INSERT INTO trend_items (snapshot_id, rank, title, subtitle, url, metric, item_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const run = db.transaction((): number => {
    const result = insertSnapshot.run(input.sourceId, input.genre, input.fetchedAt, input.ok ? 1 : 0, input.error);
    const snapshotId = Number(result.lastInsertRowid);
    if (input.ok) {
      for (const item of input.items) {
        insertItem.run(snapshotId, item.rank, item.title, item.subtitle, item.url, item.metric, trendKey(item.title));
      }
    }
    return snapshotId;
  });
  return run();
}

interface ItemRow {
  rank: number;
  title: string;
  subtitle: string | null;
  url: string | null;
  metric: string | null;
  item_key: string;
}

/** 成功した取得を新しい順に count 件 (今回と前回の比較に使う)。 */
export function latestOkSnapshots(db: Db, sourceId: string, count = 2): StoredSnapshot[] {
  const snapshots = db.prepare(
    'SELECT id, fetched_at FROM trend_snapshots WHERE source_id = ? AND ok = 1 ORDER BY fetched_at DESC, id DESC LIMIT ?',
  ).all(sourceId, count) as { id: number; fetched_at: string }[];
  const itemsOf = db.prepare(
    'SELECT rank, title, subtitle, url, metric, item_key FROM trend_items WHERE snapshot_id = ? ORDER BY rank',
  );
  return snapshots.map((snapshot) => ({
    id: snapshot.id,
    fetchedAt: snapshot.fetched_at,
    items: (itemsOf.all(snapshot.id) as ItemRow[]).map((row) => ({
      rank: row.rank, title: row.title, subtitle: row.subtitle, url: row.url, metric: row.metric, key: row.item_key,
    })),
  }));
}

export function latestAttempt(db: Db, sourceId: string): SnapshotAttempt | null {
  const row = db.prepare(
    'SELECT fetched_at, ok, error FROM trend_snapshots WHERE source_id = ? ORDER BY fetched_at DESC, id DESC LIMIT 1',
  ).get(sourceId) as { fetched_at: string; ok: number; error: string | null } | undefined;
  return row ? { fetchedAt: row.fetched_at, ok: row.ok === 1, error: row.error } : null;
}

/** このソースで各キーが初めて見えた時刻 (保持期間内の履歴から)。 */
export function firstSeenByKey(db: Db, sourceId: string): Map<string, string> {
  const rows = db.prepare(`
    SELECT i.item_key AS item_key, MIN(s.fetched_at) AS first_seen
    FROM trend_items i JOIN trend_snapshots s ON s.id = i.snapshot_id
    WHERE s.source_id = ? AND s.ok = 1
    GROUP BY i.item_key
  `).all(sourceId) as { item_key: string; first_seen: string }[];
  return new Map(rows.map((row) => [row.item_key, row.first_seen]));
}

export function lastCrawledAt(db: Db): string | null {
  const row = db.prepare('SELECT MAX(fetched_at) AS at FROM trend_snapshots').get() as { at: string | null } | undefined;
  return row?.at ?? null;
}

/** cutoff より古い取得を消す。 foreign_keys が無効でも残らないよう items を先に消す。 */
export function pruneSnapshotsBefore(db: Db, cutoffIso: string): number {
  const run = db.transaction((): number => {
    db.prepare('DELETE FROM trend_items WHERE snapshot_id IN (SELECT id FROM trend_snapshots WHERE fetched_at < ?)').run(cutoffIso);
    return db.prepare('DELETE FROM trend_snapshots WHERE fetched_at < ?').run(cutoffIso).changes;
  });
  return run();
}
