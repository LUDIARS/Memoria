# Memoria Multi-Server (Memoria Hub)

[設計書](../../docs/multi-server-architecture.md)

`server/multi/` は **マルチサーバ専用** のコード。 ローカルサーバ (`server/index.js`) からは独立した別 Node プロセスとして起動する。

## 構成

```
server/multi/
├── index.js               # Hono entry — service-adapter middleware + /api/shared/*
├── cernere-bridge.js      # CernereServiceAdapter で /ws/service に常時接続
├── db.js                  # Postgres adapter (pg)
├── migrate.js             # SQL マイグレーション runner
├── package.json           # ローカルとは別 deps (pg, hono, @ludiars/cernere-service-adapter, ws)
├── .env.example           # 設定テンプレート (rev3)
└── migrations/
    ├── 001_init.sql
    ├── 002_implementation_notes.sql
    ├── 004_work_locations.sql
    └── 005_workplace_presence.sql
```

## 認証モデル (rev3 — Cernere accessToken 直接検証)

Cernere の設計思想に従い、 **Hub は Cernere の `/auth` 一族にしか触らない**。

```
[Cernere]                         [Memoria-Hub]                        [Memoria-Local SPA]
  /auth (REST + WS)                  authMiddleware                      cernere-composite
  ↓                                  ↓                                   ↓
  ・ユーザログイン UI                  ・Cernere accessToken (HS256) を      ・loginWithPopup() で
  ・/api/auth/login                    HMAC ローカル検証                    Cernere ログイン UI
    /api/auth/register               ・claim sub → userId, role → role     を popup 表示
    /api/auth/exchange               ・iat/exp で TTL チェック              ・終わったら
  ・user 個人情報の単一情報源           ・cernere-bridge は /ws/service        accessToken を取得
                                       接続を試みる (Cernere 側 endpoint
                                       未実装のため auto-reconnect 中)
```

**重要点**:
- Hub は Cernere に毎リクエスト問い合わせない (純ローカル HMAC 検証)
- Hub は user の個人データを保管しない (Cernere が単一情報源)
- 旧 OAuth Authorization Code + PKCE / password grant 経路は撤去

### 既知の TODO (Cernere との設計合わせ)
- **Cernere `/ws/service` 未実装**: `cernere-service-adapter` v0.3 の README は `ws://cernere/ws/service` を期待するが Cernere 本体に endpoint がまだ無い。 admission push (user_admission → service_token mint) は future work。 当面は `cernere-bridge.js` が auto-reconnect ループする (warn のみ、 機能影響なし)。
- **`@ludiars/cernere-id-cache` の claim 名不一致**: middleware 実装が `payload.userId` を読むが Cernere JWT は RFC 7519 標準の `sub` を使う。 暫定で Hub に小さい自前 middleware (`verifyCernereJwt` in `index.js`) を inline して `sub` claim を読む。 id-cache 改修の PR を Cernere 側に出すのが本筋。

## セットアップ

```bash
cp .env.example .env
# 編集して Postgres / CERNERE_* / SERVICE_JWT_SECRET を設定

npm install              # @ludiars/cernere-service-adapter は file:link で参照
npm run migrate          # 001_init.sql 等を適用
npm run dev              # http://localhost:5280
```

`@ludiars/cernere-service-adapter` はローカル dev では `file:../../../Cernere/packages/service-adapter` 経由で取得 (Cernere ワークスペースが同 PC にある前提)。 production では GitHub Packages から pull する。

## エンドポイント

| Method | Path | 認証 | 説明 |
| --- | --- | --- | --- |
| GET | `/healthz` | – | liveness |
| GET | `/api/me` | Cernere token | 自分のユーザ情報 (id / role) |
| GET | `/api/shared/bookmarks` | – | 公開ブクマ一覧 (cursor: `before=<shared_at>`) |
| POST | `/api/shared/bookmarks` | Cernere token | 自分の bookmark を共有 |
| DELETE | `/api/shared/bookmarks/:id` | Cernere token | 自分のシェア取り下げ。 admin/mod は他人も |
| GET | `/api/shared/digs` | – | 公開 dig session 一覧 |
| POST | `/api/shared/digs` | Cernere token | dig session を共有 |
| DELETE | `/api/shared/digs/:id` | Cernere token | 取り下げ |
| GET | `/api/shared/dictionary` | – | 公開辞書 (`q=` で部分一致) |
| POST | `/api/shared/dictionary` | Cernere token | 辞書エントリを共有 |
| DELETE | `/api/shared/dictionary/:id` | Cernere token | 取り下げ |
| GET | `/api/shared/implementation-notes` | – | 実装自慢 一覧 |
| POST | `/api/shared/implementation-notes` | Cernere token | 実装自慢を共有 |
| DELETE | `/api/shared/implementation-notes/:id` | Cernere token | 取り下げ |
| GET | `/api/shared/work-locations` | – | 作業場所一覧 |
| POST | `/api/shared/work-locations` | Cernere token | 作業場所を共有 |
| DELETE | `/api/shared/work-locations/:id` | Cernere token | 取り下げ |
| POST | `/api/shared/workplace-presence` | Cernere token | enter / leave |
| GET | `/api/shared/workplace-presence(/current)` | Cernere token | 直近 / 現在 |
| POST | `/api/shared/moderation/(hide\|unhide)` | Cernere token (mod/admin) | モデレーション |
| GET | `/api/shared/moderation/(hidden\|log)` | Cernere token (mod/admin) | モデレーション履歴 |

「Cernere token」 = `POST <cernere>/api/auth/login` で得られる accessToken (HS256 JWT、 30 day TTL、 issuer=Cernere)。 Hub の middleware が `CERNERE_JWT_SECRET` (Cernere の `.env` `JWT_SECRET` と同じ値) で HMAC ローカル検証する。

シェア・取り下げは `share_log` に監査記録を書く。

## 認証フロー (現状: Cernere accessToken 直接検証)

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant L as Memoria-Local (SPA)
  participant C as Cernere
  participant H as Memoria-Hub

  U->>L: 「Hub に接続」
  L->>C: POST /api/auth/login { email, password }<br/>(or composite popup / GitHub / Google)
  C-->>L: { accessToken (HS256), user }
  L->>L: app_settings.multi_jwt = accessToken に保存

  Note over L,H: 以降のシェア操作は Cernere 介在なし
  L->>H: POST /api/shared/bookmarks<br/>Authorization: Bearer accessToken
  H->>H: HMAC verify (CERNERE_JWT_SECRET 共有)<br/>claim sub → userId, role → role
  H-->>L: 201 Created
```

accessToken は Cernere 発行 (HS256 JWT, 30 day TTL, claims: `sub` / `role` / `iat` / `exp`)。 Hub は per-request で Cernere に問い合わせない (ローカル HMAC 検証)。 期限切れたら再ログイン。

将来 Cernere `/ws/service` が実装されたら、 `cernere-bridge.js` 経由の admission push + Hub 自己発行 service_token (短命) パターンに切り替える予定。

## CORS

`MEMORIA_HUB_ALLOWED_ORIGINS` (CSV) に列挙したオリジンのみ。 未設定だと `/api/*` は cross-origin から呼べない。

## デプロイ

`docker-compose.yml` で Postgres + Hub を 1 コマンド起動。

```bash
cd server/multi
cp .env.example .env
# 編集 — CERNERE_*, SERVICE_JWT_SECRET, POSTGRES_PASSWORD は最低限変更すること

docker compose up -d --build
docker compose logs -f hub          # マイグレーション + 起動ログ + cernere-bridge connect
curl -fsS http://localhost:5280/healthz
```

ストレージは名前付きボリューム `memoria-hub-pg` に永続化。 バックアップは `pg_dump`:

```bash
docker compose exec postgres pg_dump -U memoria memoria_hub > backup.sql
```

## ローカル開発 (smoke-tested 2026-05-09)

PostgreSQL + Redis をコンテナで上げ、 Cernere と Memoria Hub を native node で動かす。

```bash
# 1. PG (Cernere の cernere DB + Hub の memoria_hub DB を共有) と Redis を起動
docker run -d --name cernere-pg -p 15432:5432 \
  -e POSTGRES_USER=cernere -e POSTGRES_PASSWORD=cernere -e POSTGRES_DB=cernere \
  postgres:17-alpine
docker run -d --name cernere-redis -p 6379:6379 redis:7-alpine \
  redis-server --appendonly yes
# Hub 用 DB を追加
docker exec cernere-pg psql -U cernere -c "CREATE USER memoria WITH PASSWORD 'memoria';"
docker exec cernere-pg psql -U cernere -c "CREATE DATABASE memoria_hub OWNER memoria;"

# (注: port 5432 が Windows host で詰まる場合は 15432 等の別ポートに退避。
#  Rancher Desktop の vpnkit stuck 既知バグ。)

# 2. Cernere 起動 (.env の DATABASE_URL を 127.0.0.1:15432/cernere に向ける)
cd E:/Document/Ars/Cernere
npm run dev:server   # dotenv-cli 経由、 server/ の `npm run dev` 単独では .env を読まない

# 3. Cernere に admin を register + login して JWT_SECRET を確認
curl -s -X POST http://127.0.0.1:8080/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"adminpass-strong-123","name":"Admin"}'

# 4. Memoria Hub の .env に **Cernere の JWT_SECRET と同じ値**を入れる
#    CERNERE_JWT_SECRET=<Cernere の .env JWT_SECRET と同値>
#    MEMORIA_PG_URL=postgres://memoria:memoria@127.0.0.1:15432/memoria_hub
cd E:/Document/Ars/Memoria/server/multi
cp .env.example .env  # 編集
node --env-file=.env migrate.js     # Hub の Postgres スキーマを適用
npm run dev                          # http://localhost:5280
```

end-to-end smoke:

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"adminpass-strong-123"}' \
  | jq -r .accessToken)

# Hub /api/me が Cernere user を返すこと
curl http://127.0.0.1:5280/api/me -H "Authorization: Bearer $TOKEN"
# → {"userId":"54c4ad72-...","role":"admin"}

# Hub に bookmark を共有
curl -X POST http://127.0.0.1:5280/api/shared/bookmarks \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","title":"Test","summary":"e2e"}'
# → {"id":"1","shared_at":"..."}
```

将来 Cernere に `/ws/service` (service-adapter のための admission push) が実装されたら、 `CERNERE_SERVICE_CODE` / `CERNERE_SERVICE_SECRET` で managed_projects 登録 (currently the migration `017_memoria_managed_project_seed.sql` で seed されるが client_secret rotate API がまだ Cernere 側に無いので使えない) → Hub `cernere-bridge.js` が WS 接続成立 → service_token 経由のフローに切替。

### TLS / リバースプロキシ

Hub は HTTPS を実装しない。 本番では Caddy / nginx / Cloudflare Tunnel 等で TLS 終端し 127.0.0.1:5280 にプロキシする。

```caddy
hub.memoria.example.com {
  reverse_proxy 127.0.0.1:5280
  encode zstd gzip
}
```

`MEMORIA_HUB_ALLOWED_ORIGINS` に Memoria ローカルの公開オリジンを列挙すること (例 `https://memoria.example.com`)。

## 進捗

- **Phase 0**: ✅ db façade + core/local/multi seam (PR #40)
- **Phase 1**: ✅ ローカル SQLite に共有メタカラム追加 + Postgres 初期スキーマ (PR #35)
- **Phase 2**: ✅ MVP — Cernere SSO scaffold + /api/shared/* (PR #41)
- **Phase 3**: ✅ 📤 ローカル UI からの share button (PR #42)
- **Phase 4**: ✅ 🌐 ローカル UI からの multi タブ + proxy (PR #43)
- **Phase 5**: ✅ 📥 multi → ローカル ダウンロード (PR #44)
- **Phase 6**: ✅ モデレーション (admin/mod) (PR #46)
- **Phase 7**: ✅ docker-compose stack + 登録ランブック
- **Phase 8 (rev3)**: 🚧 OAuth PKCE 撤去 → service-adapter / id-cache パターン
