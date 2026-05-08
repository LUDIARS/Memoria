# impl — 実装自慢 API

| method | path | req | res |
|---|---|---|---|
| GET | `/api/implementation-notes` | `?limit=100&offset=0` | `{ items: ImplementationNoteRow[] }` |
| POST | `/api/implementation-notes` | `ImplementationNoteCreateRequest` | `{ note: ImplementationNoteRow }` |
| PATCH | `/api/implementation-notes/:id` | `ImplementationNoteUpdateRequest` | `{ note: ImplementationNoteRow }` |
| DELETE | `/api/implementation-notes/:id` | — | `{ ok: true }` |
| POST | `/api/implementation-notes/:id/share` | — | `{ ok: true, note: ImplementationNoteRow }` |

## 注意
- attachment_type が `github` のときは attachment_value が github.com の URL であることを **クライアント側でバリデート** する (server もバリデート可能)。
- attachment_type が `screenshot` のときは attachment_value に `data:image/...` が入る (画像 paste / drop)。
