-- Hub 共有用 AI ノート。redaction_scanned_at を NOT NULL にして、
-- スキャンを通っていない記事が Hub に入る経路を DB 層でも遮断する。
CREATE TABLE IF NOT EXISTS ai_articles (
  id                    BIGSERIAL PRIMARY KEY,
  origin_local_id       BIGINT NOT NULL,
  title                 TEXT NOT NULL,
  body_md               TEXT NOT NULL,
  topic_key             TEXT,
  for_date              DATE,
  tags_json             JSONB,
  source_refs_json      JSONB,
  note_subject_id       UUID,
  share_policy          TEXT NOT NULL,
  redaction_scanned_at  TIMESTAMPTZ NOT NULL,
  owner_user_id         TEXT NOT NULL,
  owner_user_name       TEXT NOT NULL,
  shared_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  shared_origin         TEXT,
  hidden_at             TIMESTAMPTZ,
  hidden_by             TEXT,
  hidden_reason         TEXT,
  UNIQUE (owner_user_id, origin_local_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_articles_owner_date
  ON ai_articles (owner_user_id, for_date DESC);

CREATE INDEX IF NOT EXISTS idx_ai_articles_shared
  ON ai_articles (shared_at DESC);
