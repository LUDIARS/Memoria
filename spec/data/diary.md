# diary — 日記 + 週報 + 設定

## `diary_entries`
日付ごとの日記 (1 日 1 行)。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `date` | TEXT | ✓ | — | PK 'YYYY-MM-DD' (local TZ) |
| `summary` | TEXT |  | NULL | 全体サマリ (Opus 1M) |
| `work_content` | TEXT |  | NULL | 作業内容 (Sonnet) |
| `highlights` | TEXT |  | NULL | ハイライト (Opus 1M) |
| `notes` | TEXT |  | NULL | ユーザメモ |
| `metrics_json` | TEXT |  | NULL | アクセス hourly / 食事 / 軌跡 等の集計 (JSON) |
| `github_commits_json` | TEXT |  | NULL | リポ別 commit 件数 (JSON) |
| `work_minutes` | INTEGER |  | NULL | Sonnet が推定した作業時間 (分) |
| `status` | TEXT | ✓ | `pending` | `pending` / `done` / `error` |
| `error` | TEXT |  | NULL | |
| `created_at` `updated_at` | TEXT | ✓ | UTC | |

## `weekly_reports`
週報 (日曜 23:05 cron)。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `week_start` | TEXT | ✓ | — | PK 'YYYY-MM-DD' |
| `week_end` | TEXT | ✓ | — | 'YYYY-MM-DD' |
| `month` | TEXT | ✓ | — | 'YYYY-MM' |
| `week_in_month` | INTEGER | ✓ | — | その月の何週目か |
| `summary` `github_summary_json` | TEXT |  | NULL | |
| `status` `error` `created_at` `updated_at` | — | — | — | diary_entries と同様 |

Index: `idx_weekly_month`

## `diary_settings`
key/value (GitHub PAT, user info, repos)。
