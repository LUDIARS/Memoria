# agent — AI 委託 API (agent_projects + agent_runs)

## agent_projects

| method | path | req | res |
|---|---|---|---|
| GET | `/api/agent-projects` | — | `{ items: AgentProjectRow[] }` |
| POST | `/api/agent-projects` | `AgentProjectCreateRequest` | `{ project: AgentProjectRow }` (201) |
| PATCH | `/api/agent-projects/:id` | `AgentProjectUpdateRequest` | `{ project: AgentProjectRow }` |
| DELETE | `/api/agent-projects/:id` | — | `{ ok: true }` |

## agent_runs

| method | path | req | res |
|---|---|---|---|
| GET | `/api/agent-runs` | `AgentRunListQuery` (qs) | `{ items: AgentRunRow[] }` |
| GET | `/api/agent-runs/:id` | — | `{ run: AgentRunRow, running: boolean }` |
| GET | `/api/agent-runs/:id/log` | `?tail=N` | `{ run, running, log: string }` |
| POST | `/api/agent-runs/:id/cancel` | — | `{ ok: true }` |

開始は `/api/tasks/:id/agent-run` (task.md 参照)。

## 注意
- `project.path` は **絶対パス**必須 (CLI の cwd になる)。
- `model` 未指定時は `agent` のデフォルト (`claude_code → sonnet`,
  `codex → 5.3-codex`, `gemini → gemini-2.5-flash`)。
