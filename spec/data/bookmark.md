# bookmark — ブックマーク + カテゴリ + アクセス履歴

## `bookmarks`
1 件のブックマーク (URL + ローカル HTML スナップショット + AI 要約)。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoincrement | PK |
| `url` | TEXT | ✓ | — | 元 URL (ユニーク制約は無いが index あり) |
| `title` | TEXT | ✓ | — | ページタイトル |
| `html_path` | TEXT | ✓ | — | HTML ファイル名 (`<DATA>/html/<file>`) |
| `summary` | TEXT |  | NULL | AI 要約結果 |
| `memo` | TEXT | ✓ | `''` | ユーザメモ |
| `status` | TEXT | ✓ | `'pending'` | `pending` / `done` / `error` |
| `error` | TEXT |  | NULL | 要約エラー |
| `created_at` | TEXT | ✓ | `datetime('now')` (UTC) | 追加時刻 |
| `updated_at` | TEXT | ✓ | `datetime('now')` (UTC) | 最終更新 |
| `last_accessed_at` | TEXT |  | NULL | 最終アクセス (UTC) |
| `access_count` | INTEGER | ✓ | 0 | アクセス回数 |
| `owner_user_id` | TEXT |  | NULL | Hub からダウンロードした行の Cernere user id (NULL=自分) |
| `owner_user_name` | TEXT |  | NULL | 同上 表示名 |
| `shared_at` | TEXT |  | NULL | Hub にシェアした時刻 (UTC) |
| `shared_origin` | TEXT |  | NULL | シェア先 Hub URL |

### Index
- `idx_bookmarks_status` (`status`)
- `idx_bookmarks_url` (`url`)

## `bookmark_categories`
ブックマーク ↔ カテゴリの many-to-many。

| 列 | 型 | NotNull | 役割 |
|---|---|---|---|
| `bookmark_id` | INTEGER | ✓ | FK → bookmarks(id), CASCADE |
| `category` | TEXT | ✓ | カテゴリ名 |

PK: `(bookmark_id, category)`
Index: `idx_bookmark_categories_category`

## `accesses`
ブックマークが開かれた履歴 (アクセスごとに 1 行追加、 最終アクセス時刻だけは
`bookmarks.last_accessed_at` にも反映)。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoincrement | PK |
| `bookmark_id` | INTEGER | ✓ | — | FK → bookmarks(id), CASCADE |
| `accessed_at` | TEXT | ✓ | `datetime('now')` | UTC ISO |

Index: `idx_accesses_bookmark` (`bookmark_id, accessed_at DESC`)
