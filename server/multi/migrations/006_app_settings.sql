-- Hub の key-value 設定ストア。 ローカル Memoria の SQLite app_settings 相当。
--
-- 主用途は Infisical machine identity (infisical.*) の永続化。 Hub は起動時に
-- bootstrap.js がここを読んで process.env に載せ、 Infisical から残りの
-- アプリ設定 (CERNERE_BASE_URL 等) を取得する。
--
-- 値は機微情報を含む (infisical.client_secret) ため、 GET / の設定状態 API は
-- client_secret を返さない (configured フラグのみ)。

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
