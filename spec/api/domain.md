# domain — ドメイン辞書 API

| method | path | req | res |
|---|---|---|---|
| GET | `/api/domains` | `?q=&kind=` | `{ items: DomainCatalogRow[] }` |
| POST | `/api/domains/from-url` | `{ url: string }` | `{ domain, queued: true, duplicate: boolean }` |
| GET | `/api/domains/:domain` | — | `DomainCatalogRow` |
| PATCH | `/api/domains/:domain` | `DomainUpdateRequest` | `DomainCatalogRow` |
| POST | `/api/domains/:domain/regenerate` | — | `{ queued: true }` |
| DELETE | `/api/domains/:domain` | — | `{ ok: true }` |
| POST | `/api/domains/recatalog-all` | `{ force?: boolean }` | `RecatalogResult` |

## 注意
- `/api/domains/from-url` は URL or hostname を受け、 host を抽出して classify キュー投入。 既存行があっても再分類。
- `regenerate` は user_edited を保護 (manual に書いたフィールドは上書きしない)。
- `recatalog-all` の force=true は user_edited 行も再分類対象に含める。
