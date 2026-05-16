import type { EnvCliConfig } from "../../../Cernere/packages/env-cli/src/types.js";

/**
 * Memoria Hub の env-cli 設定。
 *
 * 用途:
 *   npm run env:setup        Infisical 初回設定 (machine identity を .env.secrets に保存)
 *   npm run env:gen          Infisical から secret を fetch して .env を生成
 *   npm run env:list         Infisical 登録 secret の一覧
 *   npm run env:set <K> <V>  Infisical に secret を登録
 *   npm run env:test         Infisical 接続テスト
 *
 * 設計ノート:
 *   - INFISICAL_* (machine identity) は Infisical に置けない (chicken-and-egg)。
 *     env-cli setup で .env.secrets に保存 → bootstrap.js が起動時に読む。
 *   - infraKeys のデフォルト値は docker-compose の dev fallback。
 *     Infisical に同名キーがあればそちらが優先される。
 *   - 個人 secret (CERNERE_SERVICE_SECRET / SERVICE_JWT_SECRET / JWT 系) は
 *     必ず Infisical に登録すること (デフォルトは dev 用プレースホルダ)。
 */

const config: EnvCliConfig = {
  name: "Memoria Hub",

  /**
   * docker-compose / アプリケーションが .env から読むキーとデフォルト値。
   * Infisical に同名キーがあればそちらを優先。
   */
  infraKeys: {
    // ─── Hub プロセス自身 ───────────────────────────────────
    MEMORIA_HUB_PORT: "5280",
    MEMORIA_HUB_BASE: "http://localhost:5280",
    // PASETO の aud claim 検証用。 Hub の公開 URL と完全一致させる。
    MEMORIA_HUB_PUBLIC_URL: "http://localhost:5280",
    // CORS 許可 origin (CSV)。 ローカル Memoria SPA を許可する想定。
    MEMORIA_HUB_ALLOWED_ORIGINS: "http://localhost:5180",

    // ─── docker-compose (Postgres) ──────────────────────────
    POSTGRES_USER: "memoria",
    POSTGRES_PASSWORD: "memoria",
    POSTGRES_DB: "memoria_hub",
    MEMORIA_HUB_HOST_PORT: "5280",
    MEMORIA_PG_POOL: "10",

    // ─── Hub の Postgres 接続 URL ───────────────────────────
    // docker compose 経由なら postgres サービスの DNS 名 (postgres:5432) で OK。
    // 単独起動 (= host から直接) なら 127.0.0.1:<exposed port>。
    MEMORIA_PG_URL: "postgres://memoria:memoria@postgres:5432/memoria_hub",

    // ─── Cernere 連携 (二層設計 auth flow) ──────────────────
    // Hub が代理ログイン + PASETO 公開鍵 fetch する先。
    CERNERE_BASE_URL: "http://host.docker.internal:8080",
    // managed_projects.key (= cernereProjectToken に渡す project_key)。
    MEMORIA_CERNERE_PROJECT_KEY: "memoria",

    // ─── Cernere service-adapter (将来 /ws/service 経由の admission push 用) ──
    CERNERE_WS_URL: "ws://host.docker.internal:8080/ws/service",
    CERNERE_SERVICE_CODE: "memoria-hub",
    // 以下は dev placeholder。 本番では必ず Infisical に登録する。
    CERNERE_SERVICE_SECRET: "dev-secret-placeholder",
    SERVICE_JWT_SECRET: "memoria-hub-dev-jwt-secret-replace-in-production",

    // ─── 旧 HS256 互換 (PASETO 移行期間中の legacy client 受付用) ──────────
    // Cernere の JWT_SECRET と同値にする。 PASETO 経路が安定したら撤去予定。
    CERNERE_JWT_SECRET: "memoria-hub-dev-cernere-jwt-secret",
  },

  /** Hub は server/multi/.env.secrets に machine identity を持つ。 */
  secretsPath: ".env.secrets",
  /** Hub は server/multi/.env に生成する (docker compose が読む先)。 */
  dotenvPath: ".env",

  defaultSiteUrl: "https://infisical.vtn-game.com",
  defaultEnvironment: "dev",

  /**
   * production 環境で env-cli env を実行したとき、 Infisical に存在しない
   * (= dev 用 placeholder のまま) と .env 生成を中止するキー。
   * dev fallback が本番に漏れると致命的になる項目を列挙。
   */
  required: {
    production: [
      "MEMORIA_PG_URL",
      "MEMORIA_HUB_PUBLIC_URL",
      "CERNERE_BASE_URL",
      "CERNERE_SERVICE_SECRET",
      "SERVICE_JWT_SECRET",
      "CERNERE_JWT_SECRET",
      "POSTGRES_PASSWORD",
    ],
  },
};

export default config;
