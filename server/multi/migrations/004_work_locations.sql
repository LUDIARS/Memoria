CREATE TABLE IF NOT EXISTS work_locations (
  id                BIGSERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  address           TEXT,
  latitude          DOUBLE PRECISION,
  longitude         DOUBLE PRECISION,
  description       TEXT,
  url               TEXT,
  tags              TEXT,
  owner_user_id     TEXT NOT NULL,
  owner_user_name   TEXT NOT NULL,
  shared_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  shared_origin     TEXT,
  hidden_at         TIMESTAMPTZ,
  hidden_by         TEXT,
  hidden_reason     TEXT
);

CREATE INDEX IF NOT EXISTS idx_work_locations_owner
  ON work_locations(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_work_locations_shared
  ON work_locations(shared_at DESC);
