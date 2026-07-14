-- Hub Shell apps registry — Phase 0 PLACEHOLDER.
-- See spec/feature/hub-shell.md §9.3.
--
-- This file is NOT a real migration yet. Phase 1 will:
--   1. Move this DDL into server/multi/migrations/NNN_hub_apps.sql with a
--      proper sequence number.
--   2. Wire it into server/multi/migrate.js so memoria-multi-server applies
--      it on startup.
--
-- Until then this file documents the intended shape so reviewers can spot
-- problems early.

CREATE TABLE IF NOT EXISTS hub_apps (
  id                  TEXT        PRIMARY KEY,                              -- manifest.id (e.g. 'bibliotheca')
  manifest_url        TEXT        NOT NULL,                                 -- fetch source URL
  manifest_json       JSONB       NOT NULL,                                 -- last validated manifest
  display_order       INTEGER     NOT NULL DEFAULT 0,                       -- tab order
  enabled             BOOLEAN     NOT NULL DEFAULT TRUE,
  installed_by        TEXT        NOT NULL,                                 -- Cernere user id (admin role)
  installed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_refetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_etag           TEXT,                                                  -- If-None-Match cache key
  last_error          TEXT                                                   -- non-null = last refetch failed
);

-- Active tabs query (the only hot path): list enabled apps ordered by display_order.
CREATE INDEX IF NOT EXISTS hub_apps_display_order_idx
  ON hub_apps (display_order, id)
  WHERE enabled;

-- manifest_url is informational; the same id from a different url is treated as
-- a re-install (UPDATE), not a duplicate. UNIQUE on id (the PK) is sufficient.
