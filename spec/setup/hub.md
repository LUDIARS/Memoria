# 複数ユーザで共有する Hub (マルチサーバ) の設定

## 目的

辞書 / Dig / ブックマークを **複数ユーザで共有** するハブ (Memoria Hub) を建てる。
Cernere SSO で認証する **別プロセス** で、 Postgres 必須。 個人利用の Memoria を
1 人で動かすぶんには不要。

> これが Memoria における「オンライン / 共有」 経路。 個人ライフログ
> (GPS / 日記 / 履歴) は Hub に出ず手元に残り、 Hub に乗るのは明示的に「シェア」
> した辞書 / dig / ブクマ等のナレッジだけ ([`../../README.md`](../../README.md) C 章)。

ローカル Memoria 本体の設定ではなく **`server/multi/`** 配下の独立スタックの設定。

## 設定キー (`server/multi/.env.example`)

雛形: [`../../server/multi/.env.example`](../../server/multi/.env.example) をコピーして
`server/multi/.env` を作る。

### Hono / Postgres

| キー | 既定 | 説明 |
|---|---|---|
| `MEMORIA_HUB_PORT` | `5280` | Hub の listen port |
| `MEMORIA_HUB_BASE` | `http://localhost:5280` | 公開 base URL (CORS / 自己 URL 起点) |
| `MEMORIA_PG_URL` | `postgres://memoria:memoria@localhost:5432/memoria_hub` | Postgres 接続 |
| `MEMORIA_PG_POOL` | `10` | コネクションプール数 |

### Cernere service-adapter (認証)

Hub は Cernere の `/ws/service` に常時接続し、 `user_admission` を passive に受信して
短命 `service_token` を mint する。 login UI は Cernere 側が持つ。

| キー | 既定 | 説明 |
|---|---|---|
| `CERNERE_WS_URL` | `ws://localhost:8080/ws/service` | Cernere の service WS。 docker からは `host.docker.internal` |
| `CERNERE_SERVICE_CODE` | `memoria-hub` | Cernere 上の識別キー (`managed_projects.client_id`) |
| `CERNERE_SERVICE_SECRET` | `replace-me` | `managed_projects.client_secret` (Cernere admin で生成) |
| `CERNERE_BASE_URL` | `http://localhost:8080` | Hub が Cernere に到達する URL (PASETO public key fetch 用) |
| `SERVICE_JWT_SECRET` | `replace-with-a-long-random-string` | Hub が発行する service_token (HS256) の署名鍵 |
| `CERNERE_JWT_SECRET` | (deprecated) | HS256 fallback。 PASETO v4 移行後は不要 (互換期間のみ) |
| `MEMORIA_HUB_PUBLIC_URL` | `https://hub.memoria.example.com` | PASETO の `aud` claim 検証用。 未設定だと aud 検証 skip + warn |
| `MEMORIA_HUB_ALLOWED_ORIGINS` | `http://localhost:5180` | CORS — ローカル SPA からのアクセス許可 origin |

### docker-compose 専用 (`server/multi/docker-compose.yml`)

| キー | 既定 | 説明 |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `memoria` / `memoria` / `memoria_hub` | compose が初回起動で provision する DB |
| `MEMORIA_HUB_HOST_PORT` | `5280` | host 側 bind port (コンテナは常に 5280) |

> 他にも `MEMORIA_HUB_CREDS_PATH` / `MEMORIA_CERNERE_PROJECT_KEY` 等が
> `server/multi/` 配下で参照される。 正本は `server/multi/.env.example` と
> [`../../server/multi/README.md`](../../server/multi/README.md)。

## 手順

```bash
cd server/multi
cp .env.example .env
# 編集 (最低限): CERNERE_SERVICE_SECRET / SERVICE_JWT_SECRET / MEMORIA_HUB_PUBLIC_URL
#               / MEMORIA_HUB_ALLOWED_ORIGINS / POSTGRES_PASSWORD

docker compose up -d --build
docker compose logs -f hub
curl http://localhost:5280/healthz
```

その後ローカル Memoria の ⚙ AI → 🌐 マルチサーバ にこの URL を入れて接続すると、
シェア / マルチタブ閲覧 / ダウンロード / (admin/mod なら) モデレーションができる
([`../../README.md`](../../README.md) C 章)。 本番 Cernere OAuth クライアント登録の
ランブックは [`../../server/multi/README.md`](../../server/multi/README.md)。

## 注意点

- **Hub はローカル Memoria とは別物**。 個人 1 人運用では不要。 ローカル側で
  `CERNERE_BASE_URL` を設定する必要は無い (Hub 側が持つ /
  `server/env-cli.config.ts:43-48`)。
- **secret 系は必ず差し替える**。 `replace-me` / `replace-with-...` のままだと
  認証が成立しない / 脆弱。 `SERVICE_JWT_SECRET` は `openssl rand -base64 48` 等。
- **`MEMORIA_HUB_PUBLIC_URL` 未設定だと PASETO の aud 検証が skip** され warn が出る
  (一時的な互換動作)。 本番では必ず設定。
- **`CERNERE_JWT_SECRET` は deprecated**。 PASETO v4 移行 (Cernere#91) の互換期間
  fallback で、 cutover 後は削除する。
- **個人データは Cernere 単一情報源 / 自前 DB に持たない**方針。 Hub の Postgres に
  個人ライフログを溜める設計にはしない ([[project_personal_data_rule]])。

## トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| `/healthz` が返らない | compose ログ確認。 Postgres 起動待ち / port 競合 |
| 認証が通らない | `CERNERE_SERVICE_SECRET` / `CERNERE_WS_URL` を確認。 Cernere 側に project 登録済か |
| ローカルから接続不可 (CORS) | `MEMORIA_HUB_ALLOWED_ORIGINS` にローカル SPA の origin を追加 |
| token の aud 拒否 | `MEMORIA_HUB_PUBLIC_URL` が Cernere 発行 token の aud と不一致 |

## 関連

- [`README.md`](./README.md) — 設定の優先順位 / 個人データの扱い
- [`../../server/multi/README.md`](../../server/multi/README.md) — Hub 構築 + Cernere OAuth ランブック
- [`../../docs/multi-server-architecture.md`](../../docs/multi-server-architecture.md) — Hub アーキテクチャ
- [`../api/multi.md`](../api/multi.md) — マルチサーバ API 仕様
