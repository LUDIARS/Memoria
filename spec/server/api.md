# Backend HTTP API

すべて `/api/*` 配下、JSON 入出力。`online` モードでは `Authorization: Bearer <JWT>` 必須。

## システム

| Method | Path | 用途 |
|--------|------|------|
| `GET` | `/api/mode` | 現在のモード + RAG 有効/無効 + user_id |

## Bookmarks

| Method | Path | 用途 |
|--------|------|------|
| `POST` | `/api/bookmark` | HTML+URL+title を保存。NG フィルタ → 重複チェック → 要約キュー投入 |
| `GET` | `/api/bookmarks?category=&sort=` | 一覧 (user_id でスコープ) |
| `GET` | `/api/bookmarks/:id` | 詳細 |
| `PATCH` | `/api/bookmarks/:id` | メモ・カテゴリ更新 |
| `DELETE` | `/api/bookmarks/:id` | 削除 (HTML ファイルも) |
| `GET` | `/api/bookmarks/:id/html` | 保存 HTML 本体 (Content-Type: text/html) |
| `GET` | `/api/bookmarks/:id/accesses` | アクセス履歴 |
| `POST` | `/api/bookmarks/:id/resummarize` | 要約のやり直し (memo は保持) |
| `GET` | `/api/categories` | カテゴリ一覧 + 件数 |

## Visits (local-only)

`MEMORIA_MODE=online` のとき以下はすべて 403。

| Method | Path | 用途 |
|--------|------|------|
| `POST` | `/api/access` | URL+title を upsert + 既存ブックマークならアクセス記録 |
| `GET` | `/api/visits/unsaved` | 当日 (local date) の未ブックマーク URL |
| `GET` | `/api/visits/suggested?days=N` | N 日間 + 保存漏れスコア |
| `GET` | `/api/visits/unsaved/count` | バッジ用件数 |
| `POST` | `/api/visits/bookmark` | `{urls[]}` を fetch + 要約キュー投入 |
| `DELETE` | `/api/visits` | `{urls[]}` を履歴行から削除 |

## Trends

| Method | Path | 用途 |
|--------|------|------|
| `GET` | `/api/trends/timeline?days=N` | 日次の保存数 + アクセス数 (zero-fill) |
| `GET` | `/api/trends/categories?days=N&limit=` | カテゴリ別保存数 (top 12) |
| `GET` | `/api/trends/category-diff?days=7` | 直近 vs 前期の増減 (top 8) |
| `GET` | `/api/trends/domains?days=N` | アクセス回数トップドメイン (top 12) |

## Recommendations

| Method | Path | 用途 |
|--------|------|------|
| `GET` | `/api/recommendations` | キャッシュ済み推薦 (30 分 TTL) |
| `GET` | `/api/recommendations?force=1` | 再計算 |
| `POST` | `/api/recommendations/dismiss` | `{url}` を以降除外 |
| `DELETE` | `/api/recommendations/dismissals` | dismiss リスト全削除 |

## RAG

| Method | Path | 用途 |
|--------|------|------|
| `GET` | `/api/rag/status` | enabled / model / 進捗 / chunk 数 |
| `POST` | `/api/rag/backfill` | 未インデックスを全部キュー投入 |
| `POST` | `/api/rag/reindex/:id` | 1 件再インデックス |
| `GET` | `/api/search?q=&limit=` | 意味検索 |
| `POST` | `/api/ask` | `{q, k}` → claude が引用付き回答 |

## Dig

| Method | Path | 用途 |
|--------|------|------|
| `POST` | `/api/dig` | `{query}` → セッション作成 + キュー投入 |
| `GET` | `/api/dig` | 履歴 30 件 |
| `GET` | `/api/dig/:id` | セッション詳細 |
| `POST` | `/api/dig/:id/save` | `{urls[]}` を保存 |

## Queue

| Method | Path | 用途 |
|--------|------|------|
| `GET` | `/api/queue` | 深度 + running (両キュー) |
| `GET` | `/api/queue/items` | snapshot (実行中・queued・history) |

## Export / Import

| Method | Path | 用途 |
|--------|------|------|
| `POST` | `/api/export` | `{ids?, includeHtml?}` → JSON ダウンロード |
| `POST` | `/api/import` | `{bookmarks[]}` を取り込み (URL 重複はスキップ) |

## エラー応答

```json
{ "error": "メッセージ" }
```

代表的な status code:
- `400` Bad Request (パラメータ不足)
- `401` Unauthorized (online モードで JWT 不正/失効)
- `403` Forbidden (visits を online で叩いた等)
- `404` Not Found
- `422` Unprocessable Entity (NG フィルタでブロック)
- `500` Internal Server Error
- `503` Service Unavailable (RAG 無効化時)
