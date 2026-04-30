# Memoria Multi-Server (Memoria Hub)

[設計書](../../docs/multi-server-architecture.md)

`server/multi/` は **マルチサーバ専用** のコード。ローカルサーバ
(`server/index.js`) からは独立した別 Node プロセスとして起動する。

## 構成

```
server/multi/
├── index.js               # Hono entry — Cernere SSO + /api/shared/*
├── db.js                  # Postgres adapter (pg)
├── auth.js                # Cernere OAuth (Authorization Code + PKCE) + JWT
├── migrate.js             # SQL マイグレーション runner
├── package.json           # ローカルとは別 deps (pg, jose, hono, ...)
├── .env.example           # 設定テンプレート
└── migrations/
    └── 001_init.sql       # Postgres スキーマ初期化 (Phase 1 で着地済み)
```

## セットアップ

```bash
cp .env.example .env
# 編集して Postgres / Cernere / JWT secret を設定

npm install
npm run migrate          # 001_init.sql を適用
npm start                # http://localhost:5280
```

## エンドポイント (Phase 2 MVP)

| Method | Path | 認証 | 説明 |
| --- | --- | --- | --- |
| GET | `/healthz` | – | liveness |
| GET | `/api/auth/start` | – | Cernere に redirect。query で `redirect_uri` を渡す |
| GET | `/api/auth/callback` | – | code → JWT を mint してユーザの `redirect_uri` に戻す |
| GET | `/api/me` | JWT | user_id / display_name / role |
| GET | `/api/shared/bookmarks` | – | 公開ブクマ一覧 (cursor: `before=<shared_at>`) |
| POST | `/api/shared/bookmarks` | JWT | 自分の bookmark を共有 |
| DELETE | `/api/shared/bookmarks/:id` | JWT | 自分のシェア取り下げ。admin/mod は他人も |
| GET | `/api/shared/digs` | – | 公開 dig session 一覧 |
| POST | `/api/shared/digs` | JWT | dig session を共有 |
| DELETE | `/api/shared/digs/:id` | JWT | 取り下げ |
| GET | `/api/shared/dictionary` | – | 公開辞書 (`q=` で部分一致) |
| POST | `/api/shared/dictionary` | JWT | 辞書エントリを共有 |
| DELETE | `/api/shared/dictionary/:id` | JWT | 取り下げ |

シェア・取り下げは `share_log` に監査記録を書く (Phase 6 のモデレーション
UI が利用予定)。

## 認証フロー (詳細)

1. ローカル UI が `GET <hub>/api/auth/start?redirect_uri=<self>` を踏ませる。
2. Hub は PKCE verifier/challenge を生成し、Cernere の
   `/oauth/authorize` に 302 (`code_challenge_method=S256`)。
3. Cernere が `<hub>/api/auth/callback?code=...&state=...` に戻す。
4. Hub は `cookie` 内の verifier で `/oauth/token` を叩いて access_token を
   取得 → Cernere `/api/me` から user 情報を取得 → Memoria-Hub JWT を mint。
5. ユーザの `redirect_uri` に `?memoria_hub_jwt=<jwt>` 付きで 302。
6. ローカル UI は JWT を `app_settings.multi_jwt` に保存し、以後
   `Authorization: Bearer <jwt>` を付けて Hub の API を叩く。

JWT は HS256 / 30 日 / `iss=memoria-hub`。リフレッシュは無し (再ログインで
作り直す。Cernere SSO 側のセッションが効いていれば user 操作は不要)。

## CORS

`MEMORIA_HUB_ALLOWED_ORIGINS` (CSV) に列挙したオリジンのみ。未設定だと
`/api/*` は cross-origin から呼べない。同一オリジン (Hub の Web UI) からは
当然動く。

## 進捗

- **Phase 0**: ✅ db façade + core/local/multi seam (PR #40)
- **Phase 1**: ✅ ローカル SQLite に共有メタカラム追加 + Postgres 初期スキーマ (PR #35)
- **Phase 2**: ✅ MVP (Cernere SSO + /api/shared/*) — このディレクトリ
- **Phase 3**: 📤 ローカル UI からの share button (#34)
- **Phase 4**: 🌐 ローカル UI からの multi タブ + proxy (#34)
- **Phase 5**: 📥 multi → ローカル ダウンロード (#34)
- **Phase 6**: モデレーション (admin/mod) (#34)
- **Phase 7**: Cernere OAuth クライアント本番登録 + docker-compose 一式 (#34)
