# visit — GPS / アクセス履歴 / ページメタ API

## locations (GPS)

| method | path | req | res |
|---|---|---|---|
| POST | `/api/locations/ingest` | OwnTracks JSON | `{ ok: true }` (auth: ingest_key 必須) |
| GET | `/api/locations` | `?date=YYYY-MM-DD` or `?from=&to=&device=` | `{ date?, from?, to?, deviceId, points: GpsLocationRow[] }` |
| GET | `/api/locations/days` | `?limit=180` | `{ days: { day, points, first_at, last_at }[] }` |
| DELETE | `/api/locations` | `?older_than=ISO` | `{ removed: number }` |
| GET | `/api/locations/settings` | — | `LocationSettingsResponse` |
| POST | `/api/locations/settings/regenerate` | — | `{ key }` (1 度だけ表示) |
| POST | `/api/locations/settings/clear` | — | `{ ok: true }` |
| POST | `/api/locations/compress` | `{ since?, until? }` | `{ before, after, removed }` |
| GET | `/api/locations/unresolved` | `?limit=` | `{ items: GpsLocationRow[] }` |
| POST | `/api/locations/resolve-all` | — | `{ queued: number }` |

## visits (per-event)

| method | path | req | res |
|---|---|---|---|
| GET | `/api/visits` | `?days=` | `{ items: PageVisit[] }` |
| GET | `/api/visits/suggested` | `?days=30` | `{ items }` |
| GET | `/api/visits/unsaved/count` | — | `{ count: number }` |
| DELETE | `/api/visits` | `{ urls: string[] }` | `{ ok: true, removed }` |
| POST | `/api/visits/save` | `{ urls: string[] }` | `{ results: BulkSaveResult[] }` |
| POST | `/api/visits/external` | `VisitExternalIngest` | `{ ok: true }` (Legatus DNS/SNI) |
| GET | `/api/visits/external/stats` | — | `{ ... }` |
| POST | `/api/access` | `{ url }` | `{ ok: true }` (Chrome 拡張からの ping) |

## page-metadata

| method | path | req | res |
|---|---|---|---|
| GET | `/api/page-metadata` | `?url=` | `PageMetadataRow` |
| POST | `/api/page-metadata/refresh` | `{ url }` | `{ queued: true }` |

## worklog 集計 (date 単位)

| method | path | req | res |
|---|---|---|---|
| GET | `/api/worklog/server-events` | `?date=` | `{ items: ServerEventRow[] }` |
| GET | `/api/worklog/browsing` | `?date=` | `WorklogBrowsingResponse` |
| GET | `/api/worklog/activity` | `?date=&kind=` | `{ items: ActivityEventRow[], total, page }` |
| GET | `/api/uptime` | — | `{ heartbeat, downtime_threshold_ms }` |
