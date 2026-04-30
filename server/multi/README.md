# Memoria Multi-Server (Memoria Hub)

[設計書](../../docs/multi-server-architecture.md)

`server/multi/` 配下はマルチサーバ専用のコード。ローカルサーバ (`server/index.js`) と共有テーブル定義は core 層を経由する。

## 構成 (予定)
```
server/multi/
├── index.js            # Hono app entry — Cernere SSO + /api/shared/*
├── db.js               # Postgres 抽象 (better-sqlite3 と同じ shape を返す)
├── auth.js             # Cernere OAuth フロー + JWT (HS256, 30 日)
├── shared.js           # /api/shared/bookmarks /digs /dictionary
├── moderation.js       # admin / mod 専用エンドポイント
└── migrations/
    └── 001_init.sql    # Postgres スキーマ初期化
```

## 起動 (予定)
```
MEMORIA_MULTI=1
MEMORIA_PG_URL=postgres://...
MEMORIA_CERNERE_OAUTH_CLIENT=<id>
MEMORIA_CERNERE_OAUTH_SECRET=<secret>
MEMORIA_JWT_SECRET=<long-random>
node multi/index.js
```

## 進捗
Phase 0 (server を core/local/multi に分離) と Phase 2 (MVP) は別 PR で実装する。
