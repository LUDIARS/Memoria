# agent — タスクの AI 委託 (Claude Code / Codex / Gemini)

## `agent_projects`
ユーザがタスクを「AI 実装」 する際に使う実行コンテキスト (cwd + ルール)。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `name` | TEXT | ✓ | — | "Memoria" 等 |
| `path` | TEXT | ✓ | — | 絶対パス。 spawn の cwd に使う |
| `rules` | TEXT |  | NULL | Markdown。 プロンプト先頭に貼られる |
| `default_agent` | TEXT | ✓ | `claude_code` | `claude_code` / `codex` / `gemini` |
| `created_at` `updated_at` | TEXT | ✓ | UTC | |

## `agent_runs`
1 タスクの 1 実行 = 1 行。 stdout/stderr は `<DATA>/agent_logs/<file>` に
ストリーム保存。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `task_id` | INTEGER |  | NULL | tasks(id) — 任意 |
| `project_id` | INTEGER |  | NULL | agent_projects(id) |
| `agent` | TEXT | ✓ | — | `claude_code` / `codex` / `gemini` |
| `model` | TEXT |  | NULL | 例: `sonnet` / `5.3-codex` / `gemini-2.5-flash` |
| `prompt` | TEXT |  | NULL | 実際に CLI に渡したプロンプト全体 |
| `status` | TEXT | ✓ | `pending` | `pending` / `running` / `done` / `failed` / `cancelled` |
| `exit_code` | INTEGER |  | NULL | |
| `log_path` | TEXT |  | NULL | `agent_logs/` 配下のファイル名 |
| `pid` | INTEGER |  | NULL | 実行中プロセスの PID (cancel 用) |
| `summary` | TEXT |  | NULL | ログ tail から抽出した要約 |
| `started_at` | TEXT | ✓ | UTC | |
| `finished_at` | TEXT |  | NULL | UTC ISO |

Index: `idx_agent_runs_task` / `idx_agent_runs_status`
