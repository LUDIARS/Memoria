# Database (SQLite)

`data/memoria.db` (WAL モード, foreign_keys=ON)。
すべて `service/db.js` の `openDb()` で `CREATE IF NOT EXISTS` + 後方互換 `ALTER TABLE` で初期化される (DROP は禁止 — AIFormat ルールに準拠)。

## テーブル

### bookmarks
保存記事のメタデータ。

| 列 | 型 | 説明 |
|----|----|------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `url` | TEXT NOT NULL | 一意性は `(user_id, url)` で管理 (実装は `findBookmarkByUrl` 内) |
| `title` | TEXT NOT NULL | 500 字に切り詰め |
| `html_path` | TEXT NOT NULL | `data/html/<filename>` のファイル名のみ |
| `summary` | TEXT | claude 生成、200〜400 字 |
| `memo` | TEXT NOT NULL DEFAULT '' | ユーザー編集可 |
| `status` | TEXT NOT NULL | `pending` / `done` / `error` |
| `error` | TEXT | 失敗理由 (500 字切詰) |
| `created_at` / `updated_at` | TEXT | `datetime('now')` UTC |
| `last_accessed_at` | TEXT | `accesses` 行追加と同時に更新 |
| `access_count` | INTEGER NOT NULL DEFAULT 0 | カウンタ |
| `user_id` | TEXT | online モードのスコープ。local では NULL |

Indexes: `status`, `url`, `user_id`

### bookmark_categories
ブックマークごとのカテゴリ (3〜5)。

| 列 | 型 | 説明 |
|----|----|------|
| `bookmark_id` | INTEGER NOT NULL FK→bookmarks ON DELETE CASCADE | |
| `category` | TEXT NOT NULL | |
| PK: `(bookmark_id, category)` | | |

Index: `category`

### accesses
ブックマークへのアクセス履歴 (1 アクセス = 1 行)。

| 列 | 型 | 説明 |
|----|----|------|
| `id` | INTEGER PK | |
| `bookmark_id` | INTEGER NOT NULL FK→bookmarks ON DELETE CASCADE | |
| `accessed_at` | TEXT NOT NULL | `datetime('now')` UTC |

Index: `(bookmark_id, accessed_at DESC)`

### page_visits
未ブックマークも含む閲覧 URL の追跡 (local 用)。

| 列 | 型 | 説明 |
|----|----|------|
| `url` | TEXT PK | URL ごとに 1 行 (upsert) |
| `title` | TEXT | |
| `first_seen_at`, `last_seen_at` | TEXT | UTC |
| `visit_count` | INTEGER NOT NULL DEFAULT 1 | |
| `user_id` | TEXT | online モードのスコープ |

Index: `last_seen_at DESC`, `user_id`

### chunks
RAG 用の文書チャンク + 埋め込みベクトル。

| 列 | 型 | 説明 |
|----|----|------|
| `id` | INTEGER PK | |
| `bookmark_id` | INTEGER NOT NULL FK→bookmarks ON DELETE CASCADE | |
| `idx` | INTEGER NOT NULL | チャンク番号 (0=ヘッダー, 1+=本文) |
| `text` | TEXT NOT NULL | 700 字、120 字 overlap、最大 30 個 |
| `vec` | BLOB NOT NULL | Float32Array の生バイト (384 dim) |
| `vec_dim` | INTEGER NOT NULL | 次元数 (検証用) |
| `vec_model` | TEXT NOT NULL | デフォルト 'multilingual-e5-small' |

Index: `bookmark_id`

### dig_sessions
ディグるセッションの履歴。

| 列 | 型 | 説明 |
|----|----|------|
| `id` | INTEGER PK | |
| `query` | TEXT NOT NULL | |
| `created_at` | TEXT | UTC |
| `status` | TEXT NOT NULL | `pending` / `done` / `error` |
| `error` | TEXT | |
| `result_json` | TEXT | claude が返した `{query, summary, sources[]}` の JSON |

Index: `created_at DESC`

### recommendation_dismissals
ユーザーが「却下」した推薦 URL。

| 列 | 型 | 説明 |
|----|----|------|
| `url` | TEXT PK | |
| `dismissed_at` | TEXT | UTC |

## マイグレーション戦略

- 全テーブル: `CREATE IF NOT EXISTS`
- 列追加: `PRAGMA table_info` で存在チェック → なければ `ALTER TABLE ADD COLUMN`
- DROP は禁止 (AIFormat ルール)
- 列の型変更は新規列を追加して移行する

## user スコープ

`local` モード:
- 全クエリで `user_id = NULL` の行のみ操作
- `userId = null` を渡すと `userClause` が WHERE 句を空に

`online` モード:
- `c.get('userId')` (= JWT.sub) を全 listing/get/insert に渡す
- `getBookmark(db, id, { userId })` は user_id 不一致なら null を返す
- 新規挿入時に `bookmarks.user_id` / `page_visits.user_id` を設定

## バックアップ

- DB: `VACUUM INTO 'backup.db'` で WAL 統合済みのコピー
- HTML: `data/html/` をフォルダごとコピー
- 例: `Memoria-backups/<ts>/{memoria.db, html/}` (リポジトリ外)
