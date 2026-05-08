# workplace — 作業場所 / GPS 自動チェックイン / セッション API

## work_locations CRUD

| method | path | req | res |
|---|---|---|---|
| GET | `/api/work-locations` | `?limit=200&offset=0` | `{ items: WorkLocationRow[] }` |
| POST | `/api/work-locations` | `WorkLocationCreateRequest` | `{ location: WorkLocationRow }` (201) |
| PATCH | `/api/work-locations/:id` | `WorkLocationUpdateRequest` | `{ location: WorkLocationRow }` |
| DELETE | `/api/work-locations/:id` | — | `{ ok: true }` |

## GPS 自動

| method | path | req | res |
|---|---|---|---|
| POST | `/api/work-locations/resolve-place` | `{ latitude, longitude }` | `ResolvePlaceResponse` |
| POST | `/api/work-locations/checkin` | `{ latitude, longitude }` | `CheckinResponse` |
| GET | `/api/work-sessions` | `?date=YYYY-MM-DD` | `WorkSessionsResponse` |

## 注意
- resolve-place は OpenStreetMap Nominatim 既定。 設定で他の Place API に切替可。
- checkin は `workplace_match_radius_m` (privacy settings) 内の最近接 work_location とマッチ。
- work-sessions は **GPS の連続点を 1 セッションに畳む** + 60 分以上のみ items に含める。
  全期間集計は `tallies` フィールドで返却。
