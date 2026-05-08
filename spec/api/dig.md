# dig — Deep research + ワードクラウド API

## dig

| method | path | req | res |
|---|---|---|---|
| POST | `/api/dig` | `DigStartRequest` | `{ id, status, queueDepth }` |
| GET | `/api/dig` | `?limit=` | `{ items: DigSessionRow[] }` |
| GET | `/api/dig/:id` | — | `DigSessionRow` |
| DELETE | `/api/dig/:id` | — | `{ ok: true }` |
| POST | `/api/dig/:id/save` | `{ urls: string[] }` | `{ results: BulkSaveResult[] }` |
| GET | `/api/dig/engines` | — | `{ items: { id, label }[] }` |
| GET | `/api/dig/themes` | — | `{ items: string[] }` |

## wordcloud

| method | path | req | res |
|---|---|---|---|
| POST | `/api/wordcloud` | `WordCloudCreateRequest` | `{ id }` |
| GET | `/api/wordcloud` | — | `{ items: WordCloudRow[] }` |
| GET | `/api/wordcloud/:id` | — | `WordCloudRow & { graph?: WordCloudGraph }` |
| GET | `/api/wordcloud/:id/graph` | — | `WordCloudGraph` |
| GET | `/api/wordcloud/:id/siblings` | — | `{ items: WordCloudRow[] }` |
| POST | `/api/wordcloud/merge` | `{ ids: number[] }` | `{ id }` |
| POST | `/api/wordcloud/validate-word` | `{ word, context }` | `{ ok: boolean, reason?: string }` |
| POST | `/api/bookmarks/:id/wordcloud` | — | `{ id }` |
| GET | `/api/bookmarks/:id/wordcloud` | — | `WordCloudRow \| null` |
