# page — ページメタ + ドメイン辞書

## `page_metadata`
URL ごとの og: / meta / 要約キャッシュ。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `url` | TEXT | ✓ | — | PK |
| `title` `meta_description` `og_title` `og_description` `og_image` `og_type` `content_type` | TEXT |  | NULL | HTML head 由来 |
| `http_status` | INTEGER |  | NULL | fetch 時の HTTP status |
| `summary` | TEXT |  | NULL | AI 要約結果 |
| `kind` | TEXT |  | NULL | 分類 (例: ドキュメント / ブログ / SaaS) |
| `status` | TEXT | ✓ | `pending` | `pending` / `done` / `error` |
| `error` | TEXT |  | NULL | |
| `fetched_at` | TEXT |  | NULL | UTC ISO |

Index: `idx_page_metadata_status`

## `domain_catalog`
ドメイン単位の辞書。 lazy fetch + AI 分類。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `domain` | TEXT | ✓ | — | PK |
| `title` `site_name` `description` `can_do` `kind` `notes` | TEXT |  | NULL | AI 出力 + ユーザ編集 |
| `user_edited` | INTEGER | ✓ | 0 | 1 で AI 自動上書き拒否 |
| `domain_private` | INTEGER | ✓ | 0 | 1 で日記処理から除外 |
| `status` | TEXT | ✓ | `pending` | `pending` / `done` / `error` |
| `error` | TEXT |  | NULL | |
| `fetched_at` | TEXT |  | NULL | UTC ISO |
