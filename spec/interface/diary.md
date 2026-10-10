# diary — 日記 / 週報 API

| method | path | req | res |
|---|---|---|---|
| GET | `/api/diary` | `?month=YYYY-MM` | `DiaryMonthResponse` |
| GET | `/api/diary/:date` | — | `DiaryDetailResponse` |
| POST | `/api/diary/:date/generate` | — | `{ queued: true, status }` |
| PATCH | `/api/diary/:date/notes` | `{ notes: string }` | `DiaryEntryRow` |
| DELETE | `/api/diary/:date` | — | `{ ok: true }` |
| POST | `/api/diary/:date/improve` | `{ improve: string }` | `DiaryEntryRow` |
| GET | `/api/diary/:date/digs` | `?limit=200` | `{ items: DigSessionRow[] }` |
| GET | `/api/diary/:date/sections` | — | `{ date, items: DiarySection[] }` |
| GET | `/api/diary/:date/sections/:source` | — | `DiarySection` (無ければ 404) |
| PUT | `/api/diary/:date/sections/:source` | `{ title: string, markdown: string }` | `DiarySection` (同一端末のみ、 違反 400 / 遠隔 403) |
| DELETE | `/api/diary/:date/sections/:source` | — | `{ ok: true }` (無ければ 404、 同一端末のみ) |
| GET | `/api/weekly` | — | `{ items: WeeklyReportRow[] }` |
| GET | `/api/weekly/:week_start` | — | `WeeklyReportRow` |
| POST | `/api/weekly/:week_start/generate` | — | `{ queued: true }` |
| DELETE | `/api/weekly/:week_start` | — | `{ ok: true }` |
| GET | `/api/diary-settings` | — | `Record<string, string>` |
| PATCH | `/api/diary-settings` | `Record<string, string>` | `Record<string, string>` |

## 外部節

`DiarySection` = `{ date, source, title, markdown, created_at, updated_at }`。
`date` は `YYYY-MM-DD`、 `source` は `[a-z0-9-]{1,64}`、 `title` は 1〜200 字、 `markdown` は空でなく 200KB 以下。
PUT は `diary_entries` を変えない。 `DELETE /api/diary/:date` はその日の外部節も消す。 実装: `server/diary/sections-router.ts`。
