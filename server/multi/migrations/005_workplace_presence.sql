-- Workplace presence: ephemeral "I am working at X right now" events.
-- Separate from work_locations (which is the persistent catalog) so the
-- presence stream can be queried for "who is where" without polluting
-- the curated locations list.
CREATE TABLE IF NOT EXISTS workplace_presence (
  id                BIGSERIAL PRIMARY KEY,
  user_id           TEXT NOT NULL,
  user_name         TEXT NOT NULL,
  workplace_name    TEXT NOT NULL,
  address           TEXT,
  latitude          DOUBLE PRECISION,
  longitude         DOUBLE PRECISION,
  kind              TEXT NOT NULL DEFAULT 'enter', -- 'enter' | 'leave'
  shared_origin     TEXT,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workplace_presence_user
  ON workplace_presence(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_workplace_presence_recent
  ON workplace_presence(occurred_at DESC);
