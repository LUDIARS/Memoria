-- Memoria Hub (multi-server) Postgres schema — initial cut.
--
-- Mirror of the local SQLite schema for the three shareable resources only.
-- Local-only tables (page_visits, visit_events, diary_entries, weekly_reports,
-- domain_catalog, page_metadata, accesses, server_events, app_settings,
-- bookmark_categories, recommendation_dismissals, dictionary_links,
-- word_clouds, dig_sessions.preview_json — anything not for sharing) are
-- intentionally absent.
--
-- All shared rows carry owner_user_id (Cernere user id) and a snapshot of
-- owner_user_name. shared_origin is informational ("which local server
-- forwarded this row").

CREATE TABLE bookmarks (
  id                BIGSERIAL PRIMARY KEY,
  url               TEXT NOT NULL,
  title             TEXT NOT NULL,
  summary           TEXT,
  memo              TEXT NOT NULL DEFAULT '',
  -- HTML body is *not* stored here; only the metadata.

  owner_user_id     TEXT NOT NULL,
  owner_user_name   TEXT NOT NULL,
  shared_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  shared_origin     TEXT,

  hidden_at         TIMESTAMPTZ,
  hidden_by         TEXT,
  hidden_reason     TEXT
);
CREATE INDEX idx_bookmarks_owner    ON bookmarks(owner_user_id);
CREATE INDEX idx_bookmarks_shared   ON bookmarks(shared_at DESC);

CREATE TABLE bookmark_categories (
  bookmark_id  BIGINT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  PRIMARY KEY (bookmark_id, category)
);

CREATE TABLE dictionary_entries (
  id            BIGSERIAL PRIMARY KEY,
  term          TEXT NOT NULL,
  definition    TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  owner_user_id     TEXT NOT NULL,
  owner_user_name   TEXT NOT NULL,
  shared_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  shared_origin     TEXT,

  hidden_at         TIMESTAMPTZ,
  hidden_by         TEXT,
  hidden_reason     TEXT,

  -- Same term can exist for multiple users on the multi-server.
  UNIQUE (owner_user_id, term)
);
CREATE INDEX idx_dictionary_owner   ON dictionary_entries(owner_user_id);

CREATE TABLE dig_sessions (
  id            BIGSERIAL PRIMARY KEY,
  query         TEXT NOT NULL,
  status        TEXT NOT NULL,
  result_json   JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  owner_user_id     TEXT NOT NULL,
  owner_user_name   TEXT NOT NULL,
  shared_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  shared_origin     TEXT,

  hidden_at         TIMESTAMPTZ,
  hidden_by         TEXT,
  hidden_reason     TEXT
);
CREATE INDEX idx_dig_owner    ON dig_sessions(owner_user_id);
CREATE INDEX idx_dig_shared   ON dig_sessions(shared_at DESC);

-- Audit log for moderation actions and shares.
CREATE TABLE share_log (
  id              BIGSERIAL PRIMARY KEY,
  resource_kind   TEXT NOT NULL,             -- 'bookmark' | 'dig' | 'dict'
  resource_id     BIGINT NOT NULL,
  action          TEXT NOT NULL,             -- 'share' | 'hide' | 'unhide' | 'delete'
  acting_user_id  TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  details_json    JSONB
);
CREATE INDEX idx_share_log_at      ON share_log(occurred_at DESC);
CREATE INDEX idx_share_log_target  ON share_log(resource_kind, resource_id);
