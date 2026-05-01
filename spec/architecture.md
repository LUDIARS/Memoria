# Memoria Server Architecture (post-refactor 2026-05-01)

## レイヤー図

```
┌─────────────────────────────────────────────────────┐
│  HTTP / WebSocket boot (server/index.js, 1330 行)   │
│  - Hono app 構築 + middleware (cors, access-log)    │
│  - 各種 queue / closure helper の初期化             │
│  - cron (midnight diary, Sunday weekly)             │
│  - WebSocket 配信 (location)                         │
│  - MQTT subscriber (任意)                            │
│  - app.route('/api/<group>', createXxxRouter(deps)) │
└────────────┬────────────────────────────────────────┘
             │ deps 注入
             ↓
┌─────────────────────────────────────────────────────┐
│  Routes (server/routes/<group>.js, 10 file)         │
│  - bookmarks / meals / dig / wordcloud / dictionary │
│  - diary / trends / recommendations / push / admin  │
│  - factory pattern: createXxxRouter({ deps })       │
└────────────┬────────────────────────────────────────┘
             │
             ↓
┌─────────────────────────────────────────────────────┐
│  Domain logic (server/diary/, server/meals.js, …)   │
│  - diary: aggregate / gps / nutrition / github /    │
│           prompt / generate / date                   │
│  - meals: queue + Vision API + 解析パイプライン     │
│  - 純関数中心、 DB は引数で受ける (DI)              │
└────────────┬────────────────────────────────────────┘
             │
             ↓
┌─────────────────────────────────────────────────────┐
│  Repository (server/db/<domain>.js, 17 file)        │
│  - bookmarks / meals / dig / visits / wordcloud /   │
│    dictionary / page-metadata / domain-catalog /    │
│    server-events / diary / trends / gps / push /    │
│    sharing / settings / schema / _helpers           │
│  - SQL は better-sqlite3 prepared statement         │
│  - Drizzle 化は将来計画 (LUDIARS 標準合わせ)        │
└────────────┬────────────────────────────────────────┘
             │
             ↓
┌─────────────────────────────────────────────────────┐
│  Adapter façade (server/db/index.js + sqlite.js)    │
│  - MEMORIA_DB_KIND で sqlite / postgres を切替予定  │
│  - 現状は sqlite のみ                                │
└─────────────────────────────────────────────────────┘
```

## 互換性 shim

既存の import path を破壊しないため、 以下の shim を維持:

| Shim | 役割 |
|---|---|
| `server/db.js` (28 行) | `export *` から `db/<domain>.js` 全量 |
| `server/diary.js` (17 行) | `export *` from `diary/<aspect>.js` 全量 |

新規コードは `db/<domain>.js` / `diary/<aspect>.js` から直接 import 推奨。

## 依存方向 (許容)

```
routes → diary/* / meals.js / db/* / llm.js / queue.js / push.js
diary/aggregate → diary/gps + diary/nutrition + diary/date + db/*
diary/generate → diary/prompt + diary/github + llm.js
db/<domain>  → db/_helpers + better-sqlite3 (only)
```

**禁止事項**:
- `db/*.js` から `diary/` `routes/` への import (層越境)
- `diary/<aspect>.js` から `routes/` への import (上位層)
- 循環依存 (現状は無し、 ESLint で守るのは TS 化後の予定)

## レイヤー別責務

| レイヤー | 責務 | テスト戦略 |
|---|---|---|
| Routes | HTTP I/O / Zod バリデーション (将来) / 認可 | supertest 風 (`app.fetch`) — 次フェーズ |
| Domain | ビジネスロジック / 純計算 / 集計 | ユニット (`vitest`) — 純関数優先 |
| Repository | SQL 発行 / row → object マッピング | in-memory SQLite (`:memory:`) — DB roundtrip |
| Adapter | sqlite / postgres 切替 | 現状無し (将来 Phase 2) |

## モジュール統計 (post-refactor)

| 旧 | 行数 | 新 | 行数 (合計) |
|---|---|---|---|
| `db.js` | 2022 | `db/<17 file>` | ≒ 2300 (header / import 込み) |
| `diary.js` | 1212 | `diary/<7 file>` | ≒ 1300 |
| `index.js` | 3288 | `routes/<10 file>` + 縮小 `index.js` | 1330 + ≒ 2200 = 3530 |

合計コード量はほぼ同等 (header + import 増)、 1 ファイルあたりの行数が
平均 100〜200 行に収まる。

## 既知の TODO

- LLM 呼出 (`diary/generate.js`) の mock 化テスト — `runLlm` が外部副作用
- `routes/*` の `app.fetch` テスト
- multi/* (Cernere SSO) の TypeScript 化 + Drizzle 化
- 構造化ログ (pino) 導入
- SQLite 日次バックアップ
