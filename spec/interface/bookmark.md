# bookmark — ブックマーク API

| method | path | req | res |
|---|---|---|---|
| POST | `/api/bookmark` | `BookmarkSubmitRequest` (Chrome 拡張など) | `{ id: number, queued?: true, queueDepth?: number, duplicate?: true }` |
| POST | `/api/bookmarks/from-url` | `{ url: string }` | `BookmarkFromUrlResponse` |
| GET | `/api/bookmarks` | `BookmarkListQuery` (qs) | `BookmarkListResponse` |
| GET | `/api/bookmarks/:id` | — | `BookmarkRow` |
| PATCH | `/api/bookmarks/:id` | `BookmarkUpdateRequest` | `BookmarkRow` |
| DELETE | `/api/bookmarks/:id` | — | `{ ok: true }` |
| POST | `/api/bookmarks/:id/resummarize` | — | `{ ok: true, queueDepth: number }` |
| GET | `/api/bookmarks/:id/html` | — | `text/html` (HTML スナップショット) |
| GET | `/api/bookmarks/:id/accesses` | — | `{ items: AccessRow[] }` |

## 注意
- `/api/bookmark` は Chrome 拡張からの POST 経路 (HTML body を含む)。
- `/api/bookmarks/from-url` はサーバ側で fetch + 要約キューイン。 fetch 失敗時は 502。
- `/api/bookmarks` のページング: 既定 50 件、 max 200。 `?q=` でサーバ側 LIKE 検索。
