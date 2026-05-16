import type { EnvCliConfig } from "../../Cernere/packages/env-cli/src/types.js";

/**
 * Memoria local server (個人 PC 常駐版) の env-cli 設定。
 *
 * 用途:
 *   npm run env:setup        Infisical 初回設定 (machine identity を .env.secrets に保存)
 *   npm run env:gen          Infisical から secret を fetch して .env を生成
 *   npm run env:list         Infisical 登録 secret の一覧
 *   npm run env:set <K> <V>  Infisical に secret を登録
 *   npm run env:test         Infisical 接続テスト
 *
 * 設計ノート:
 *   - INFISICAL_* (machine identity) は env-cli setup で .env.secrets に保存。
 *     `tsx --env-file-if-exists=.env.secrets bootstrap.ts` がそれを読んで起動。
 *   - アプリ secret (CERNERE_BASE_URL / 各種 API key) は Infisical 側に置く。
 *     bootstrap.ts の env-bootstrap が起動時に Infisical から fetch + inject する。
 *   - Hub (server/multi/) とは別の env-cli.config.ts。 同じ Infisical project を
 *     共有しても OK だが、 使うキーは別 (Hub は MEMORIA_PG_URL 等のサーバ系、
 *     local は MEMORIA_PLACES_API_KEY 等のクライアント系)。
 */

const config: EnvCliConfig = {
  name: "Memoria (local server)",

  /**
   * ローカル起動時のフォールバック値。 Infisical に同名キーがあればそちらを優先。
   * 個人 PC 常駐前提なので docker compose は使わず、 ここの値は単に
   * `env-cli env` 実行時の .env 出力デフォルトになる。
   */
  infraKeys: {
    // ─── Hono ────────────────────────────────────────────────
    MEMORIA_PORT: "5180",

    // ─── データ保存ディレクトリ (SQLite + HTML + meals + diary 等) ─────────
    // 既定: server/../data/ (= リポ直下の data/、 gitignore 済)
    // 別ドライブに退避する場合はここを上書き。
    MEMORIA_DATA: "",

    // ─── claude CLI 経路 ─────────────────────────────────────
    MEMORIA_CLAUDE_BIN: "claude",

    // ─── Hub 連携 (二層設計の Cernere 代理ログイン) ─────────
    // ※ Multi モード時は Hub の /api/auth/login に proxy するので、
    //   ローカルは Cernere を直接知らなくて OK (Hub が自分の CERNERE_BASE_URL を持つ)。
    //   ここで CERNERE_BASE_URL を設定する必要は無い (空欄)。
    // 旧 online 経路の互換 fallback として残置可。
    CERNERE_BASE_URL: "",

    // ─── Google Maps / Places (server-side key、 referer 制限なし) ───────────
    MEMORIA_PLACES_API_KEY: "",
    // SPA に渡す key (Maps JavaScript API、 referer 制限あり)
    GOOGLE_MAPS_API_KEY: "",

    // ─── GitHub (diary commit fetch + 📋 作業一覧 タブの fallback) ───────────
    // 通常は ⚙ 連携設定で UI から PAT を入れる方が推奨。 ここはサーバ起動時の fallback。
    MEMORIA_GH_TOKEN: "",
    MEMORIA_GH_USER: "",

    // ─── Legatus (外部 OwnTracks → Memoria 転送、 旧経路。 通常は内蔵 MQTT で OK) ──
    MEMORIA_LEGATUS_WS: "off",
    MEMORIA_LEGATUS_WS_URL: "",
    MEMORIA_LEGATUS_USER_ID: "",

    // ─── MQTT (外部 broker を使う場合のみ。 内蔵 aedes を使う既定運用なら不要) ──
    MEMORIA_MQTT_URL: "",

    // ─── Steam / packet monitor / tshark (任意機能) ─────────
    MEMORIA_STEAM_DIR: "",
    MEMORIA_PACKETMON_LOG_ROOT: "",
    MEMORIA_TSHARK_BIN: "",
  },

  secretsPath: ".env.secrets",
  dotenvPath: ".env",

  defaultSiteUrl: "https://infisical.vtn-game.com",
  defaultEnvironment: "dev",

  /**
   * production 環境で env-cli env を実行したとき、 Infisical に存在しない
   * (= 空欄のまま) と .env 生成を中止するキー。 個人 PC 用なので絞っている。
   */
  required: {
    production: [],
  },
};

export default config;
