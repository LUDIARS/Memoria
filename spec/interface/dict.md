# dict — 辞書 + ストップワード API

## dictionary

| method | path | req | res |
|---|---|---|---|
| GET | `/api/dictionary` | `?q=` | `{ items: DictionaryEntryRow[] }` |
| GET | `/api/dictionary/:id` | — | `DictionaryEntryRow` |
| POST | `/api/dictionary` | `DictionaryCreateRequest` | `DictionaryEntryRow` |
| PATCH | `/api/dictionary/:id` | `DictionaryUpdateRequest` | `DictionaryEntryRow` |
| DELETE | `/api/dictionary/:id` | — | `{ ok: true }` |
| POST | `/api/dictionary/:id/links` | `{ source_kind, source_id }` | `{ ok: true }` |
| DELETE | `/api/dictionary/:id/links` | `{ source_kind, source_id }` | `{ ok: true }` |
| POST | `/api/dictionary/upsert-from-source` | `UpsertFromSourceRequest` | `DictionaryEntryRow` |

## stopwords

| method | path | req | res |
|---|---|---|---|
| GET | `/api/stopwords` | — | `{ items: UserStopwordRow[] }` |
| POST | `/api/stopwords` | `{ word: string }` | `{ ok: true }` |
| DELETE | `/api/stopwords/:word` | — | `{ ok: true }` |
