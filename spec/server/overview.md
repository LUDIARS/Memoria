# Backend Overview

## ファイル構成 (`service/`)

| ファイル | 役割 |
|---------|------|
| `index.js` | エントリポイント、Hono セットアップ、ルート登録、起動シーケンス |
| `db.js` | SQLite 初期化、スキーマ migration、CRUD ヘルパー |
| `claude.js` | HTML→テキスト抽出 + `claude -p` サブプロセス起動 |
| `queue.js` | `FifoQueue` — Promise チェーンの直列タスクキュー |
| `embeddings.js` | `@huggingface/transformers` lazy load + chunk + cosine |
| `recommendations.js` | 外部リンク抽出 + 推薦スコアリング + dismiss 永続化 |
| `dig.js` | claude CLI を WebSearch+WebFetch 許可で起動 + JSON parse |
| `content-filter.js` | NG/R18 ワード + ドメインの URL/タイトル/本文走査 |
| `auth.js` | HS256 JWT verifier + Hono middleware |
| `cernere.js` | `@ludiars/cernere-service-adapter` の lazy import + admission + peer 起動 |
| `scripts/issue-token.mjs` | 開発用 JWT 発行 CLI |
| `public/` | 静的 SPA |

## 起動シーケンス

1. `--env-file-if-exists` で `.env` / `../.env` を読み込み
2. `MEMORIA_PORT` (5180), `MEMORIA_DATA`, `MEMORIA_CLAUDE_BIN`, `MEMORIA_RAG`, `MEMORIA_MODE`, `MEMORIA_JWT_SECRET` を読み取り
3. `online` モードで `MEMORIA_JWT_SECRET` 不在なら fatal exit
4. `data/html/` を mkdirSync、`memoria.db` を better-sqlite3 で開く (WAL + foreign_keys)
5. すべてのテーブルを `CREATE IF NOT EXISTS` + 後方互換 `ALTER TABLE ADD COLUMN`
6. `summaryQueue`, `embeddingQueue`, `digQueue` (FifoQueue) を初期化
7. 起動時復旧: `bookmarks.status='pending'` を全て `enqueueSummary` で再投入
8. Hono ルート登録 (CORS → auth middleware → revoke check → routes)
9. `serve()` で listen 開始
10. `startCernere()` を呼び、SDK が居れば admission/peer 起動
11. SIGINT/SIGTERM で `stopCernere()` してから exit

## キュー設計

- 3 本独立: `summary` / `embedding` / `dig`
- 各キューは `FifoQueue` (Promise チェーン)、深度・履歴を `snapshot()` で取れる
- 履歴は最新 50 件まで in-memory (再起動で消える)

## モード

| モード | 認証 | /api/visits/* | /api/access | user スコープ |
|-------|------|--------------|-------------|--------------|
| `local` (既定) | なし | 開放 | upsert + アクセス記録 | NULL (単一ユーザー) |
| `online` | Bearer JWT 必須 | 403 | no-op | JWT.sub で per-user |

## 依存マップ

```
index.js
├ db.js ─────────┐
├ claude.js      │
├ queue.js       │
├ auth.js ◄──────┤
├ content-filter │
├ recommendations.js (← db.js)
├ embeddings.js (← @huggingface/transformers, lazy)
├ dig.js (← claude.js)
└ cernere.js (← @ludiars/cernere-service-adapter, optional, lazy)
```

## ロードマップ

- mcp-server を別ディレクトリのまま `service/` の type 定義を共有
- service 内コードを TypeScript 化 (LUDIARS 全体スタックと揃える)
- WebSocket でフロントへ push (現在ポーリング)
