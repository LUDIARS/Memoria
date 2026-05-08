# task — タスク

## `tasks`
| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `title` | TEXT | ✓ | — | |
| `details` | TEXT |  | NULL | メモ |
| `status` | TEXT | ✓ | `todo` | `todo` / `doing` / `done` |
| `creator_type` | TEXT | ✓ | `human` | `human` / `ai` |
| `due_at` | TEXT |  | NULL | 期日。 UTC ISO 形式が標準だが `YYYY-MM-DDTHH:MM` (local) も入る |
| `share_actio` | INTEGER | ✓ | 0 | 1=Actio に共有済 |
| `shared_at` | TEXT |  | NULL | UTC ISO |
| `shared_origin` | TEXT |  | NULL | 共有先 URL |
| `category` | TEXT |  | NULL | **カンマ区切り複数値** ("開発, 学習") |
| `created_at` `updated_at` | TEXT | ✓ | UTC | |

Index: `idx_tasks_status_created` / `idx_tasks_due`

## カテゴリの永続化

カテゴリは `tasks.category` の文字列カンマ区切りに加えて `app_settings`
の `task.categories.registered` (JSON 配列) で **0 件カテゴリ** も保持
される (左ペインで予約しておけるため)。
