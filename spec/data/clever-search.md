# Clever Search schema

実装: `server/clever-search/schema.ts`。

## `clever_search_sources`

既存の複数ドメインを検索専用の共通文書へ投影するローカル索引テーブル。
元テーブルの insert / update / delete trigger で同期する。
ノート本文は `note_blocks.position`、同位置では `note_blocks.id` の順で連結する。

| column | type | constraint / purpose |
|---|---|---|
| id | INTEGER | PK、FTS rowid |
| source_type | TEXT | 元データ種別 |
| source_id | TEXT | 元データID（note等の文字列IDにも対応） |
| report_category | TEXT | 5カテゴリのいずれか |
| title | TEXT | 重み付き検索タイトル |
| content | TEXT | 検索本文 |
| occurred_at | TEXT | 並び順・期間集計 |
| source_subtype | TEXT NULL | kind / source / product 等 |

`UNIQUE(source_type, source_id)`。個別ドメインの正本ではなく再生成可能な投影であり、
書き込み元は既存テーブルだけとする。

## `clever_search_fts`

`clever_search_sources` を external content にした FTS5 virtual table。
索引列は `title`, `content`。tokenizer は `trigram`。title の BM25 重みは6。

## `clever_search_reports`

| column | type | constraint / purpose |
|---|---|---|
| id | INTEGER | PK |
| query | TEXT | 表示用の元検索語 |
| normalized_query | TEXT | NFKC + 空白圧縮 + lowercase |
| total_hits | INTEGER | 一致件数 |
| report_json | TEXT | version付きレポート全文・全引用 |
| search_elapsed_ms | INTEGER | 索引検索時間 |
| created_at | TEXT | 作成日時 |

`(normalized_query, created_at DESC, id DESC)` index で最新キャッシュを取得する。
レポートの削除・上書き API は持たず、再作成時も履歴を保持する。
