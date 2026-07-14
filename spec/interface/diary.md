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
| GET | `/api/weekly` | — | `{ items: WeeklyReportRow[] }` |
| GET | `/api/weekly/:week_start` | — | `WeeklyReportRow` |
| POST | `/api/weekly/:week_start/generate` | — | `{ queued: true }` |
| DELETE | `/api/weekly/:week_start` | — | `{ ok: true }` |
| GET | `/api/diary-settings` | — | `Record<string, string>` |
| PATCH | `/api/diary-settings` | `Record<string, string>` | `Record<string, string>` |
