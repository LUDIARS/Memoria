// RSS ドメインのスキーマ作成。 openDb() の末尾から 1 回だけ呼ぶ。
//
// 全テーブルを 1 entry point (db.ts openDb) で初期化する既存方針に合わせ、
// ここでは「呼ばれる関数」 として切り出してスキーマ本体は rss 配下に置く
// (将来 mv server/rss/ で切り出せるように)。
//
// memory: CREATE INDEX は ALTER ADD COLUMN の後に冪等発行する
// ([[feedback_sqlite_create_index_after_alter]])。 ここは新規テーブルのみで
// ALTER は不要だが、 将来カラム追加するときは同じループ方式で足すこと。

import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export function ensureRssSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rss_feeds (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      url             TEXT NOT NULL UNIQUE,
      kind            TEXT NOT NULL DEFAULT 'rss',
      title           TEXT,
      site_url        TEXT,
      description     TEXT,
      category        TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1,
      last_fetched_at TEXT,
      last_status     TEXT,
      last_error      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rss_articles (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_id      INTEGER NOT NULL REFERENCES rss_feeds(id) ON DELETE CASCADE,
      guid         TEXT NOT NULL,
      url          TEXT NOT NULL,
      title        TEXT NOT NULL,
      summary      TEXT,
      author       TEXT,
      image_url    TEXT,
      meta_json    TEXT,
      published_at TEXT,
      ai_score     REAL,
      ai_reason    TEXT,
      ai_matched   TEXT,
      ai_status    TEXT NOT NULL DEFAULT 'pending',
      ai_summary   TEXT,
      starred      INTEGER NOT NULL DEFAULT 0,
      read_at      TEXT,
      notified_at  TEXT,
      fetched_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(feed_id, guid)
    );

    CREATE TABLE IF NOT EXISTS rss_interests (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      label      TEXT NOT NULL,
      prompt     TEXT NOT NULL,
      weight     REAL NOT NULL DEFAULT 1.0,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_rss_articles_feed
      ON rss_articles(feed_id, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rss_articles_score
      ON rss_articles(ai_score DESC);
    CREATE INDEX IF NOT EXISTS idx_rss_articles_pending
      ON rss_articles(ai_status);
    CREATE INDEX IF NOT EXISTS idx_rss_articles_published
      ON rss_articles(published_at DESC);

    CREATE TABLE IF NOT EXISTS rss_digests (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT NOT NULL UNIQUE,
      content     TEXT NOT NULL,
      article_ids TEXT NOT NULL DEFAULT '[]',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Forward-compat: 旧 DB に ai_summary カラムを後付け (AI 要約)。
  // memory: CREATE INDEX は ALTER の後 — ここは index 不要。
  const cols = (db.prepare(`PRAGMA table_info(rss_articles)`).all() as { name: string }[]).map(c => c.name);
  if (cols.length > 0 && !cols.includes('ai_summary')) {
    db.exec(`ALTER TABLE rss_articles ADD COLUMN ai_summary TEXT`);
  }
}
