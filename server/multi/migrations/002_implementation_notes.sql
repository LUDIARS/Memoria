CREATE TABLE IF NOT EXISTS implementation_notes (
  id                BIGSERIAL PRIMARY KEY,
  product           TEXT NOT NULL,
  title             TEXT NOT NULL,
  good_points       TEXT,
  bad_points        TEXT,
  owner_user_id     TEXT NOT NULL,
  owner_user_name   TEXT NOT NULL,
  shared_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  shared_origin     TEXT,
  hidden_at         TIMESTAMPTZ,
  hidden_by         TEXT,
  hidden_reason     TEXT
);

CREATE INDEX IF NOT EXISTS idx_impl_notes_owner
  ON implementation_notes(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_impl_notes_shared
  ON implementation_notes(shared_at DESC);
