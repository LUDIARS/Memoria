// トレンドクローラーの履歴テーブル。 openDb() の末尾から 1 回だけ呼ぶ。
//
// trend_snapshots: 1 ソース 1 回の取得 (成功/失敗)。
// trend_items: 成功した取得の 1 件ずつ。 item_key は表記ゆれを畳んだ比較用キー。
// trend_clicks: トレンドマップで開いた記録。 よく開くジャンル・話題を大きく見せる学習に使う (端末内のみ)。

import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export function ensureTrendCrawlerSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trend_snapshots (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id  TEXT NOT NULL,
      genre      TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      ok         INTEGER NOT NULL,
      error      TEXT
    );

    CREATE TABLE IF NOT EXISTS trend_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES trend_snapshots(id) ON DELETE CASCADE,
      rank        INTEGER NOT NULL,
      title       TEXT NOT NULL,
      subtitle    TEXT,
      url         TEXT,
      metric      TEXT,
      item_key    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trend_clicks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      item_key   TEXT NOT NULL,
      genre      TEXT NOT NULL,
      source_id  TEXT NOT NULL,
      clicked_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trend_clicks_at ON trend_clicks(clicked_at);
    CREATE INDEX IF NOT EXISTS idx_trend_snapshots_source ON trend_snapshots(source_id, fetched_at);
    CREATE INDEX IF NOT EXISTS idx_trend_items_snapshot ON trend_items(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_trend_items_key ON trend_items(item_key);
  `);
}
