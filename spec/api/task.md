# task — タスク API

| method | path | req | res |
|---|---|---|---|
| GET | `/api/tasks` | `TaskListQuery` (query string) | `{ items: TaskRow[] }` |
| POST | `/api/tasks` | `TaskCreateRequest` | `{ task: TaskRow }` (201) |
| PATCH | `/api/tasks/:id` | `TaskUpdateRequest` | `{ task: TaskRow }` |
| DELETE | `/api/tasks/:id` | — | `{ ok: true }` |
| GET | `/api/tasks/categories` | — | `{ items: string[] }` |
| POST | `/api/tasks/categories` | `{ name: string }` | `{ items: string[] }` (201) |
| DELETE | `/api/tasks/categories/:name` | — | `{ items: string[] }` |
| POST | `/api/tasks/:id/agent-run` | `AgentRunStartRequest` | `{ run: AgentRunRow }` (201) |
| POST | `/api/tasks/:id/share/actio` | — | `{ ok: true, result, task: TaskRow }` |

## 備考
- `category` は **カンマ区切りの複数値** ("開発, 学習") として送受信。
- `creator_type` は `'human' | 'ai'`、 デフォルト `'human'`。
- `due_at` は UTC ISO もしくは `'YYYY-MM-DDTHH:MM'` (datetime-local)。
