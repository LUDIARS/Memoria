// LINE 連携 (Concordia 経由) のテーブル。 Spec: spec/feature/line-relay.md
// - line_relay_links:      「つなぐ」 で Memoria と紐付けたトーク (talk = user:<id> / group:<id> / room:<id>)
// - line_relay_link_codes: 「つなぐ」 用の 6 桁コード (有効期限付き・1 回だけ使える)
// - line_relay_pending:    「タスク」「にっき」 の確認ボタン待ち

import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

/** Idempotent; called by every module that touches the line_relay_* tables. */
export function ensureLineRelaySchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS line_relay_links (
    talk      TEXT PRIMARY KEY,
    linked_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS line_relay_link_codes (
    code       TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS line_relay_pending (
    id         TEXT PRIMARY KEY,
    talk       TEXT NOT NULL,
    action     TEXT NOT NULL CHECK (action IN ('task', 'diary')),
    text       TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_line_relay_pending_talk ON line_relay_pending (talk)');
}
