# `db/bookmarks.js` — ブックマーク CRUD + ページング + 検索

## 目的

`bookmarks` `bookmark_categories` `accesses` 3 テーブルを跨いだ
ブックマーク関連の DAO 群。 `getBookmark` は categories を join する形で
返すため、 呼出側はテーブルを意識しない。

## 公開関数

```js
listBookmarks(db, { category?, sort?, limit?, offset?, q? }): Bookmark[]
countBookmarks(db, { category?, q? }): number
getBookmark(db, id): Bookmark | null
getCategories(db, bookmarkId): string[]
listAllCategories(db): { category, count }[]
insertBookmark(db, { url, title, htmlPath }): id
findBookmarkByUrl(db, url): Bookmark | null
setSummary(db, id, { summary, categories, status, error }): void
updateMemoAndCategories(db, id, { memo?, categories? }): void
deleteBookmark(db, id): void
insertImportedBookmark(db, b): id
recordAccess(db, bookmarkId): void
listAccesses(db, bookmarkId, limit?): Access[]
```

### `listBookmarks` の sort
- `created_desc` (default)
- `created_asc`
- `accessed_desc` (last_accessed_at 優先、 NULL は created_at fallback)
- `accessed_asc`
- `title_asc`

### `q` (search) 実装
- `title` `url` `summary` を `LIKE %q%` で OR 結合
- DB 側で評価。 frontend に全件渡してフィルタする旧方式は廃止 (#89)

### `setSummary` トランザクション
- `bookmarks.summary` `status` `error` を更新
- `categories` 配列が渡されたら、 既存の `bookmark_categories` を削除して
  上書き挿入 (空配列なら全削除)

### `updateMemoAndCategories` トランザクション
- `memo` (string) → `bookmarks.memo` 更新
- `categories` (array) → `bookmark_categories` 全置換

### `getBookmark` 副次効果
- 結果に `categories: string[]` を join して返す (DAO 側で 1+1 query)

## 不変条件

- すべて better-sqlite3 prepared statements (SQL injection なし)
- `setSummary` `updateMemoAndCategories` `deleteBookmark` は transaction
  化 — 一部失敗で中途半端な状態にならない
- `bookmark_categories` `accesses` は `ON DELETE CASCADE` で連動削除
- `findBookmarkByUrl` は同一 URL が複数あれば最新 (id DESC) を返す

## テスト

`server/test/db-bookmarks.test.js` (6 tests, in-memory SQLite)

- insert + findByUrl + getBookmark roundtrip
- setSummary がカテゴリと状態を反映
- list + count + filter + pagination
- search (LIKE) で title/url/summary を横断
- updateMemoAndCategories で全置換
- deleteBookmark cascade (categories + accesses)

## 既知の制限

- `q` の LIKE は SQLite の collation に依存 (大文字小文字非区別は ASCII のみ)
- `recordAccess` は単純 INSERT のみ (rate-limit / dedupe なし)
- `insertImportedBookmark` は import 用に簡易化 — 通常は使わない
