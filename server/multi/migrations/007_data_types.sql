-- Multi 対応 7 型のうち、 Hub にまだ無かった 2 型 (domain_catalog / notes) を追加。
-- 既存 5 型 (bookmarks / dig_sessions / dictionary_entries / implementation_notes /
-- work_locations) は migration 001/002/004 で作成済み。
--
-- あわせて implementation_notes に attachment_* カラムを補う (db.js が SELECT して
-- いるが migration 003 が欠落しているため、 IF NOT EXISTS で冪等に追加)。

ALTER TABLE implementation_notes ADD COLUMN IF NOT EXISTS attachment_type  TEXT;
ALTER TABLE implementation_notes ADD COLUMN IF NOT EXISTS attachment_value TEXT;

-- ── domain_catalog (サイト辞書) ────────────────────────────────────────────
-- ローカルは domain を PK にするが、 Hub では同じ domain を複数ユーザが登録
-- しうるので id を PK にし、 (owner_user_id, domain) を UNIQUE にする。
CREATE TABLE domain_catalog (
  id              BIGSERIAL PRIMARY KEY,
  domain          TEXT NOT NULL,
  title           TEXT,
  site_name       TEXT,
  description     TEXT,
  can_do          TEXT,
  kind            TEXT,
  notes           TEXT,

  owner_user_id   TEXT NOT NULL,
  owner_user_name TEXT NOT NULL,
  shared_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  shared_origin   TEXT,

  hidden_at       TIMESTAMPTZ,
  hidden_by       TEXT,
  hidden_reason   TEXT,

  UNIQUE (owner_user_id, domain)
);
CREATE INDEX idx_domain_catalog_owner  ON domain_catalog(owner_user_id);
CREATE INDEX idx_domain_catalog_shared ON domain_catalog(shared_at DESC);

-- ── notes (esa 風ドキュメント) ─────────────────────────────────────────────
-- ローカルの notes.id (uuid) をそのまま PK に使う。 note_blocks は別テーブルに
-- 展開せず blocks_json にシリアライズして 1 行で持つ (Hub は表示せず保管のみ)。
CREATE TABLE notes (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL DEFAULT 'doc',
  tags_json       JSONB,
  blocks_json     JSONB,
  bookmark_url    TEXT,
  source_kind     TEXT,
  source_ref      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  owner_user_id   TEXT NOT NULL,
  owner_user_name TEXT NOT NULL,
  shared_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  shared_origin   TEXT,

  hidden_at       TIMESTAMPTZ,
  hidden_by       TEXT,
  hidden_reason   TEXT
);
CREATE INDEX idx_notes_owner   ON notes(owner_user_id);
CREATE INDEX idx_notes_updated ON notes(updated_at DESC);
