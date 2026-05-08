# activity — 開発活動ログ + サーバ稼働ログ

## `activity_events`
git commit / Claude Code prompt / Codex / Gemini / タスク操作などの
**時系列イベント**を 1 つのストリームに集約。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `kind` | TEXT | ✓ | — | `git_commit` / `claude_code_prompt` / `gemini_prompt` / `codex_prompt` / `task_created` / `task_done` / `task_updated` |
| `occurred_at` | TEXT | ✓ | — | UTC ISO |
| `source` | TEXT |  | NULL | リポ名 / セッション ID 等 |
| `ref_id` | TEXT |  | NULL | commit sha / prompt UUID。 (kind, ref_id) UNIQUE で重複弾き |
| `content` | TEXT |  | NULL | commit message 1 行目 / prompt 先頭 200 文字 |
| `metadata_json` | TEXT |  | NULL | branch / author / model / cwd 等 (JSON) |
| `ingested_at` | TEXT | ✓ | UTC | |

Index: `idx_activity_events_at` / `idx_activity_events_kind_at` / UNIQUE `idx_activity_events_ref` (kind, ref_id)

## `server_events`
Memoria サーバ自身の起動 / 停止 / ダウンタイム / 再起動を記録。 日記の
作業時間推定でデータ欠落区間を識別するのに使う。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `id` | INTEGER | ✓ | autoinc | PK |
| `type` | TEXT | ✓ | — | `start` / `stop` / `downtime` / `restart` |
| `occurred_at` | TEXT | ✓ | — | UTC ISO |
| `ended_at` | TEXT |  | NULL | 区間 (downtime) の終了時刻 |
| `duration_ms` | INTEGER |  | NULL | |
| `details_json` | TEXT |  | NULL | |

Index: `idx_server_events_at` / `idx_server_events_type`
