// books ドメインのスキーマ (自己完結モジュール)。 db.ts の巨大 DDL には足さない。

import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export function ensureBooksSchema(db: Db): void {
  db.exec(`
    -- 良かった本を含む蔵書リスト。 ISBN が無い本 (Kindle 限定・同人誌) もあるので
    -- 一意キーは title_key + 先頭著者。 ISBN があるものは部分 unique index で守る。
    CREATE TABLE IF NOT EXISTS books (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      isbn13        TEXT,
      asin          TEXT,
      title         TEXT NOT NULL,
      title_key     TEXT NOT NULL,
      authors_json  TEXT NOT NULL DEFAULT '[]',
      publisher     TEXT,
      series        TEXT,
      published_on  TEXT,
      rating        INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
      review        TEXT,
      tags_json     TEXT NOT NULL DEFAULT '[]',
      read_on       TEXT,
      cover_url     TEXT,
      source        TEXT NOT NULL DEFAULT 'manual',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_books_isbn
      ON books(isbn13) WHERE isbn13 IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_books_title_key ON books(title_key);
    CREATE INDEX IF NOT EXISTS idx_books_rating ON books(rating DESC, read_on DESC);

    -- 週次巡回で見つかった新刊。 通知済みかどうかを notified_at で持つ
    -- (通知経路 = Discord が落ちていても取りこぼさないため)。
    CREATE TABLE IF NOT EXISTS book_new_releases (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      watch_kind    TEXT NOT NULL CHECK (watch_kind IN ('author', 'series')),
      watch_value   TEXT NOT NULL,
      isbn13        TEXT,
      title         TEXT NOT NULL,
      title_key     TEXT NOT NULL,
      authors_json  TEXT NOT NULL DEFAULT '[]',
      publisher     TEXT,
      published_on  TEXT,
      url           TEXT,
      cover_url     TEXT,
      source        TEXT NOT NULL,
      found_at      TEXT NOT NULL,
      notified_at   TEXT,
      dismissed_at  TEXT
    );
    -- 同じ本を毎週拾い直さないための重複キー。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_book_new_releases_key
      ON book_new_releases(watch_kind, watch_value, title_key);
    CREATE INDEX IF NOT EXISTS idx_book_new_releases_pending
      ON book_new_releases(notified_at, found_at DESC);

    -- サジェスト候補。 生成のたびに未 dismiss の行を入れ替える。
    CREATE TABLE IF NOT EXISTS book_suggestions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      isbn13        TEXT,
      title         TEXT NOT NULL,
      title_key     TEXT NOT NULL,
      authors_json  TEXT NOT NULL DEFAULT '[]',
      publisher     TEXT,
      published_on  TEXT,
      url           TEXT,
      cover_url     TEXT,
      origin        TEXT NOT NULL CHECK (origin IN ('llm', 'rakuten_ranking', 'google_rating')),
      reason        TEXT NOT NULL DEFAULT '',
      rating        REAL,
      rating_count  INTEGER,
      sales_rank    INTEGER,
      score         REAL NOT NULL DEFAULT 0,
      generated_at  TEXT NOT NULL,
      dismissed_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_book_suggestions_score
      ON book_suggestions(dismissed_at, score DESC);

    -- 「もう薦めなくていい」 本。 title_key で恒久的に除外する
    -- (candidate 行を消しても次の生成でまた湧くため、 別テーブルに残す)。
    CREATE TABLE IF NOT EXISTS book_suggestion_blocks (
      title_key     TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      blocked_at    TEXT NOT NULL
    );
  `);
}
