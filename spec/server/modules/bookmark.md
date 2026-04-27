# Module: Bookmark

`POST /api/bookmark` から始まる保存フロー全般。

## 目的
Chrome 拡張・MCP・peer 経由で受け取った HTML/URL/title を、ファイル + DB に永続化し、要約キューへ流す。

## 責務
- NG/R18 フィルタによる事前ブロック (422)
- 同 (user_id, url) の重複検出と既存 id への merge (アクセスのみ記録)
- HTML をファイルに書き出し、メタデータを `bookmarks` テーブルに INSERT
- 要約キュー (`enqueueSummary`) と RAG キュー (`enqueueEmbedding`) のトリガー
- イベント発火: `memoria.bookmark.saved`, `memoria.summary.done`

## データフロー

```
HTTP/peer → checkContent → findBookmarkByUrl
                                  ├ 既存 → recordAccess → return {id, duplicate:true}
                                  └ なし → write HTML file
                                           → insertBookmark
                                           → recordAccess (initial)
                                           → enqueueSummary (claude)
                                              ├ done  → setSummary(done)
                                              │       → enqueueEmbedding (RAG)
                                              │       → emitEvent(summary.done)
                                              └ error → setSummary(error)
                                           → emitEvent(bookmark.saved)
                                           → return {id, queued:true}
```

## 契約

入力 (`POST /api/bookmark` body):
```json
{
  "url": "https://...",
  "title": "ページタイトル (最大 500 字)",
  "html": "<!DOCTYPE html>..."
}
```

成功:
- `200 {id, duplicate: true}` — 既存 URL
- `200 {id, queued: true, queueDepth: N}` — 新規

失敗:
- `400` — 必須フィールド不足
- `422` — `{error, reason: 'blocked_domain' | 'ng_word_in_url_or_title' | 'ng_word_in_body', matches}`
- `401/403` — online モードで認証エラー

## 主要関数

| 関数 | 場所 |
|------|------|
| `insertBookmark(db, {url, title, htmlPath, userId})` | `db.js` |
| `findBookmarkByUrl(db, url, {userId})` | `db.js` |
| `getBookmark(db, id, {userId})` | `db.js` |
| `setSummary(db, id, {summary, categories, status, error})` | `db.js` |
| `updateMemoAndCategories(db, id, {memo, categories})` | `db.js` |
| `deleteBookmark(db, id)` | `db.js` |

## 制限

- HTML 30 KB (テキスト抽出後) を超える場合は要約用に先頭 30,000 字へ切詰
- title は 500 字に切詰
- HTML ファイル名は `<ISO ts>_<rand>.html` 固定

## ロードマップ

- 同一 URL の version 管理 (上書き履歴)
- 自動カテゴリ整理 (alias / merge ルール)
- ブックマーク検索の全文インデックス (FTS5)
