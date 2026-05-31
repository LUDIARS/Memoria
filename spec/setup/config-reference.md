# 設定キー リファレンス (正本)

Memoria の全 env / app_settings キーをセクション別に列挙する。 用途別の手順は
各ガイド ([`README.md`](./README.md) のインデックス) を参照。

設定は 2 系統:
- **env** — 起動前に決まる値 / CLI / CI / ヘッドレス用。 `npm start` は
  `tsx --env-file-if-exists=.env.secrets` で起動するので、 env ファイルとして
  自動で読まれるのは **`server/.env.secrets`** だけ (`server/package.json:8,10`)。
- **app_settings** — 起動後の画面から入れる値。 SQLite `app_settings` テーブルに
  保存され再起動しても残る。 **原則 env より優先** (例外あり、 下表「解決順」 参照)。

雛形ファイル: env-cli の正本キー定義は
[`../../server/env-cli.config.ts`](../../server/env-cli.config.ts) (local) /
[`../../server/multi/.env.example`](../../server/multi/.env.example) (Hub)。

---

## ローカル server — 基本

| キー | env | 既定 | 説明 | 根拠 |
|---|---|---|---|---|
| `MEMORIA_PORT` | ✓ | `5180` | listen port | `server/index.ts:71` |
| `MEMORIA_DATA` | ✓ | `<repo>/data` | SQLite + HTML + meals + diary 保存先 | `server/index.ts:72` |
| `MEMORIA_CLAUDE_BIN` | ✓ | `claude` | claude CLI バイナリ (UI `llm.bin.claude` 優先) | `server/index.ts:76` |
| `CLAUDE_CODE_GIT_BASH_PATH` | ✓ | (自動検出) | Windows の git-bash 絶対パス (UI `runtime.git_bash_path` 優先) | `server/llm.ts:141` |
| `MEMORIA_DB_KIND` | ✓ | `sqlite` | DB アダプタ (Phase 2 で postgres 追加予定) | README |

> `MEMORIA_DB_KIND` は README の env 表に記載。 ローカル運用では既定 `sqlite` のまま。

---

## LLM プロバイダ (app_settings)

詳細は [`llm-providers.md`](./llm-providers.md)。

| キー | env / app_settings | 既定 | 説明 | 根拠 |
|---|---|---|---|---|
| `llm.<task>.provider` | app_settings | `claude` | タスク別プロバイダ | `server/llm.ts:128` |
| `llm.<task>.model` | app_settings | (既定モデル) | タスク別モデル ID | `server/llm.ts:129` |
| `llm.bin.claude` / `.gemini` / `.codex` | app_settings | `claude` / `gemini` / `codex` | CLI パス | `server/llm.ts:135-137` |
| `llm.openai.api_key` | app_settings | `''` | OpenAI API key | `server/llm.ts:139` |
| `llm.openai.model` | app_settings | `gpt-4o-mini` | OpenAI モデル | `server/llm.ts:140` |
| `runtime.git_bash_path` | app_settings → env | `''` | git-bash パス。 app_settings → `CLAUDE_CODE_GIT_BASH_PATH` | `server/llm.ts:141` |

task 一覧: `server/llm.ts:8-27`。 provider 一覧: `server/llm.ts:54-60`。

---

## WebPush 通知

詳細は [`webpush.md`](./webpush.md)。

| キー | env | 既定 | 説明 | 根拠 |
|---|---|---|---|---|
| `VAPID_PUBLIC_KEY` | ✓ | (自動生成) | VAPID 公開鍵 (`VAPID_PRIVATE_KEY` とペア) | `server/push.ts:46` |
| `VAPID_PRIVATE_KEY` | ✓ | (自動生成) | VAPID 秘密鍵 | `server/push.ts:47` |
| `VAPID_SUBJECT` | ✓ | `mailto:noreply@memoria.local` | VAPID subject | `server/push.ts:42` |

解決順: env (両鍵) → `<dataDir>/vapid.json` → 自動生成 (`server/push.ts:45-62`)。

---

## 位置情報 (GPS / MQTT / WiFi)

詳細は [`location-tracking.md`](./location-tracking.md)。

| キー | env / app_settings | 既定 | 説明 | 根拠 |
|---|---|---|---|---|
| `MEMORIA_MQTT_BROKER` | env | (起動) | `off` で内蔵 broker 停止 | `server/mqtt/broker.ts:76` |
| `MEMORIA_MQTT_BROKER_PORT` | env | `1883` | broker TCP port | `server/mqtt/broker.ts:78` |
| `MEMORIA_MQTT_BROKER_HOST` | env | `0.0.0.0` | bind host | `server/mqtt/broker.ts:79` |
| `MEMORIA_MQTT_USERNAME` | env | (無し) | broker 認証 (pass と両方で有効) | `server/mqtt/broker.ts:80` |
| `MEMORIA_MQTT_PASSWORD` | env | (無し) | broker 認証 | `server/mqtt/broker.ts:81` |
| `MEMORIA_MQTT_URL` | env | (無し) | 外部 broker を使う in-process subscriber を起動 | `server/index.ts:411` |
| `locations.ingest_key` | app_settings → env | (空=認証無効) | `/api/locations/ingest` の API key | `server/lib/ingest-auth.ts:32-36` |
| `LOCATIONS_INGEST_KEY` | env | (空) | 上記 app_settings の fallback | `server/lib/ingest-auth.ts:35` |
| `MEMORIA_GOOGLE_GEOLOCATION_API_KEY` | env | (無効) | PC WiFi → 位置 (Windows のみ) | `server/wifi-location.ts:64` |
| `MEMORIA_WIFI_INTERVAL_SEC` | env | `600` | WiFi 位置の実行間隔 (最小 60) | `server/wifi-location.ts:74` |
| `MEMORIA_PLACES_API_KEY` | env | (無し) | server-side Geocoding/Places key | `server/lib/place-resolver.ts:101` |
| `GOOGLE_MAPS_API_KEY` | env | (無し) | Maps/Places の汎用 key fallback | `server/lib/place-resolver.ts:101` / `server/routes/config.ts:306` |
| `maps.api_key` | app_settings | (無し) | SPA 用 Maps JS key (Referer 制限あり) | `server/routes/config.ts:306` |

解決順 (Places, server 側): `MEMORIA_PLACES_API_KEY` → `GOOGLE_MAPS_API_KEY` →
app_settings `maps.api_key` (`server/lib/place-resolver.ts:100-104`)。
解決順 (Maps, SPA 用): app_settings `maps.api_key` → `GOOGLE_MAPS_API_KEY`
(`server/routes/config.ts:306`)。

### Legatus (旧 OwnTracks 転送経路 / 既定 off)

| キー | env | 既定 | 説明 | 根拠 |
|---|---|---|---|---|
| `MEMORIA_LEGATUS_WS` | ✓ | `off` | `on` で旧 Legatus subscriber を opt-in | `server/index.ts:495` |
| `MEMORIA_LEGATUS_WS_URL` | ✓ | `ws://127.0.0.1:17320/ws` | Legatus WS URL | `server/lib/legatus-subscriber.ts:42` |
| `MEMORIA_LEGATUS_USER_ID` | ✓ | `me` | 取り込み user id | `server/lib/legatus-subscriber.ts:43` |

---

## 日記 / GitHub

| キー | env / app_settings | 既定 | 説明 | 根拠 |
|---|---|---|---|---|
| `MEMORIA_GH_TOKEN` | diary_settings → env | (無し) | 日記の commit 集計用 PAT | `server/routes/diary.ts:38` |
| `MEMORIA_GH_USER` | diary_settings → env | (無し) | GitHub user | `server/routes/diary.ts:39` |

---

## Discord Bot

| キー | env / app_settings | 既定 | 説明 | 根拠 |
|---|---|---|---|---|
| `features.discord.bot_token` | app_settings → env | (無し) | bot token (app_settings 優先) | `server/discord/settings.ts:42-48` |
| `MEMORIA_DISCORD_BOT_TOKEN` | env | (無し) | 上記 fallback | `server/discord/settings.ts:47` |
| `features.discord.enabled` 他 | app_settings | (各既定) | enable / self_user_id / guild_id / capture.* / ai_process | `server/discord/settings.ts` |

詳細: `spec/feature/discord-bot.md`。

---

## git / Claude Code / Codex hook (クライアント側 env)

hook スクリプトが Memoria backend を叩くときの設定 (`~/.claude` 等の hook 環境で渡す)。

| キー | env | 既定 | 説明 | 根拠 |
|---|---|---|---|---|
| `MEMORIA_URL` | ✓ | `http://localhost:5180` | hook が POST する Memoria base URL | `server/hooks/post-commit.mjs:32` 他 |
| `MEMORIA_GIT_HOOK_DEBUG` | ✓ | (無し) | `1` で post-commit hook の診断を stderr 出力 | `server/hooks/post-commit.mjs:34` |

導入手順: [`../../docs/setup/git-hooks.md`](../../docs/setup/git-hooks.md) /
[`../../docs/setup/user-setup.md`](../../docs/setup/user-setup.md)。

---

## 任意機能 (Steam / packet monitor)

| キー | env | 既定 | 説明 | 根拠 |
|---|---|---|---|---|
| `MEMORIA_STEAM_DIR` | ✓ | (自動探索) | Steam インストールディレクトリ | `server/lib/steam-vdf.ts:23` |
| `MEMORIA_PACKETMON_LOG_ROOT` | ✓ | `E:\Document\Ars\PacketMonitor\logs` 等 | packet monitor の logs root | `server/routes/packet-monitor.ts:197` |
| `MEMORIA_TSHARK_BIN` | ✓ | (PATH) | tshark バイナリパス | `server/routes/packet-monitor.ts:505` |

---

## Concordia 連携 (任意 / 既定 off)

Memoria が裏で投げた LLM プロンプト・結果を Concordia chat にログするための opt-in
(`server/concordia-forward.ts:10-22`)。

| キー | env | 既定 | 説明 |
|---|---|---|---|
| `MEMORIA_CONCORDIA_FORWARD` | ✓ | (無効) | `1` で forward 有効化 |
| `MEMORIA_CONCORDIA_URL` | ✓ | `http://127.0.0.1:17330` | Concordia base URL |
| `MEMORIA_CONCORDIA_CHANNEL` | ✓ | `memoria-cc-instructions` | chat channel 名 |

---

## Hub (マルチサーバ / `server/multi/`)

ローカル本体とは別スタック。 全キーは [`hub.md`](./hub.md) と雛形
[`../../server/multi/.env.example`](../../server/multi/.env.example) を参照。
主なもの: `MEMORIA_HUB_PORT` / `MEMORIA_HUB_BASE` / `MEMORIA_HUB_PUBLIC_URL` /
`MEMORIA_HUB_ALLOWED_ORIGINS` / `MEMORIA_PG_URL` / `MEMORIA_PG_POOL` /
`CERNERE_WS_URL` / `CERNERE_SERVICE_CODE` / `CERNERE_SERVICE_SECRET` /
`CERNERE_BASE_URL` / `SERVICE_JWT_SECRET` / `CERNERE_JWT_SECRET` (deprecated) /
`MEMORIA_CERNERE_PROJECT_KEY` / `MEMORIA_HUB_CREDS_PATH`。

---

## Infisical (machine identity / 上級者のみ)

ローカル単体運用では **不要** (`server/bootstrap.ts` は Infisical を使わない)。
集中シークレット管理をするときだけ `npm run env:setup` で `.env.secrets` に保存。

| キー | env | 説明 | 根拠 |
|---|---|---|---|
| `INFISICAL_SITE_URL` | ✓ | Infisical の URL | `server/lib/env-bootstrap.ts:44` |
| `INFISICAL_PROJECT_ID` | ✓ | workspace id | `server/lib/env-bootstrap.ts:45` |
| `INFISICAL_ENVIRONMENT` | ✓ | 環境 (既定 `dev`) | `server/lib/env-bootstrap.ts:46` |
| `INFISICAL_CLIENT_ID` | ✓ | machine identity | `server/lib/env-bootstrap.ts:47` |
| `INFISICAL_CLIENT_SECRET` | ✓ | machine identity | `server/lib/env-bootstrap.ts:48` |

---

## 雛形 / 正本ファイルへのリンク

| ファイル | 内容 |
|---|---|
| [`../../server/env-cli.config.ts`](../../server/env-cli.config.ts) | local server の env-cli キー定義 (正本) |
| [`../../server/multi/.env.example`](../../server/multi/.env.example) | Hub の env 雛形 |
| [`../../docker-compose.yml`](../../docker-compose.yml) | 外部 mosquitto 用 compose (port 1884/9002) |
| [`../../README.md`](../../README.md) | env 表 + 3 つの動かし方 |
| [`../../docs/setup/user-setup.md`](../../docs/setup/user-setup.md) | ユーザが手で入れる鍵 / hook 一覧 |
