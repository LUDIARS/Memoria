# misc — 傾向 / イベント / おすすめ / 外部チャット / activity events

## trends

| method | path | req | res |
|---|---|---|---|
| GET | `/api/trends/categories` | `?days=` | `{ items: { category, count }[] }` |
| GET | `/api/trends/category-diff` | `?days=` | `{ items }` |
| GET | `/api/trends/timeline` | `?days=` | `{ items }` |
| GET | `/api/trends/domains` | `?days=` | `{ items: { domain, hits }[] }` |
| GET | `/api/trends/visit-domains` | `?days=` | `{ items }` |
| GET | `/api/trends/work-hours` | `?days=` | `{ items: { date, minutes \| null }[] }` |
| GET | `/api/trends/keywords` | `?days=` | `{ items }` |
| GET | `/api/trends/gps-walking` | `?days=` | `{ items: { date, distance_km, walking_minutes, travel_minutes }[] }` |
| GET | `/api/trends/github` | `?days=` | `{ enabled: boolean, items? }` |

## recommend

| method | path | req | res |
|---|---|---|---|
| GET | `/api/recommendations` | — | `{ items }` |
| POST | `/api/recommendations/dismiss` | `{ url }` | `{ ok }` |
| DELETE | `/api/recommendations/dismissals` | — | `{ removed }` |

## events / external-chat

| method | path | req | res |
|---|---|---|---|
| GET | `/api/events` | `?limit=` | `{ items: ServerEventRow[] }` |
| GET | `/api/external-chat` | `?source=&limit=` | `{ items: ExternalChatMessageRow[] }` |
| POST | `/api/external-chat` | `ExternalChatPostRequest` | `{ id }` |

## activity

| method | path | req | res |
|---|---|---|---|
| GET | `/api/activity/events` | `?date=&kind=&limit=&offset=` | `{ items, total, page }` |
| POST | `/api/activity/event` | `ActivityEventCreateRequest` | `{ id, inserted: boolean }` |
