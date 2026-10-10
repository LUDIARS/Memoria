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

## `diary_sections`
外部サービスが書く日記の節 (例: Concordia デイリーゴールのまとめ)。 `diary_entries` と独立し、 日記行が無い日にも存在できる。
スキーマは `server/diary/sections-store.ts` の `ensureDiarySectionsSchema` が起動時に `CREATE TABLE IF NOT EXISTS` で作る (番号付き migration は使わない)。

| 列 | 型 | NotNull | Default | 役割 |
|---|---|---|---|---|
| `date` | TEXT | ✓ | — | 'YYYY-MM-DD' (PK の 1 つ目) |
| `source` | TEXT | ✓ | — | `[a-z0-9-]{1,64}` (PK の 2 つ目)。 例 `concordia-daily-goal` |
| `title` | TEXT | ✓ | — | 見出し (200 字まで) |
| `markdown` | TEXT | ✓ | — | 本文 Markdown (200KB まで) |
| `created_at` `updated_at` | TEXT | ✓ | UTC | |

PK: `(date, source)`。 `DELETE /api/diary/:date` で同日分も削除。 戻す場合は `DROP TABLE diary_sections` (他テーブルから参照されない)。

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
