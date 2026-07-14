# meal — 食事 API

| method | path | req | res |
|---|---|---|---|
| POST | `/api/meals` | `multipart/form-data` (photo + meta) | `MealRow` |
| POST | `/api/meals/manual` | `MealManualCreateRequest` (no photo) | `MealRow` |
| GET | `/api/meals` | `?date=YYYY-MM-DD&limit=` | `{ items: MealRow[] }` |
| GET | `/api/meals/:id` | — | `MealRow` |
| GET | `/api/meals/:id/photo` | — | `image/*` |
| PATCH | `/api/meals/:id` | `MealUpdateRequest` | `MealRow` |
| DELETE | `/api/meals/:id` | — | `{ ok: true }` |
| POST | `/api/meals/:id/reanalyze` | — | `{ queued: true }` |
| POST | `/api/meals/:id/additions` | `MealAdditionRequest` | `MealRow` |
| PATCH | `/api/meals/:id/additions/:idx` | `MealAdditionRequest` | `MealRow` |
| DELETE | `/api/meals/:id/additions/:idx` | — | `MealRow` |
