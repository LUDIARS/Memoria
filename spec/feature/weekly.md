# weekly — 週次レポート

## 概要
週単位 (日曜 23:05 cron) で 7 日分の日記をまとめて Opus 1M に渡し、 サマリ + GitHub commit 集計を生成する。 月ベースで `週 N` をラベル付け。

## ユースケース
- 1 週間の振り返り / 月次 KPI の素材
- 「先週のハイライトを LinkedIn 投稿用に」 みたいな引用元
- 月の中の `week_in_month` で N 週目を示せる

## 画面 / 入口
- `📅 日記` タブ → 月の上部 / 下部に週次レポート行
- 手動再生成 `POST /api/weekly/:weekStart/generate`

## データ
- [weekly_reports](../db/diary.md) — week_start (PK) / week_end / month / week_in_month / summary / github_summary_json / status
- 集計参照: [diary_entries](../db/diary.md) / [activity_events](../db/activity.md) / [bookmarks](../db/bookmark.md)

## API
- [diary.md](../api/diary.md) — `/api/weekly` (月一覧) / `/api/weekly/:weekStart` / `/api/weekly/:weekStart/generate` / `DELETE /api/weekly/:weekStart`

## シェア可能か
**local-only**

週次レポートを Hub にシェアする経路は無い。 日記と同じ理由で意図的に local-only。

## プライバシー観点
- **個人データを保持するテーブル**: `weekly_reports` (1 週間の生活ログ高度集約)。
- **LLM プロバイダに送る情報**: タスク `diary_weekly` (Opus 1M default) に 7 日分の日記 summary / work_content / highlights + GitHub commit 集計を渡す。 これは日記生成時の prompt より大きい個人情報量。
- **共有時に外部に出ない情報**: 週次レポート全体。
- **削除時の挙動**: `DELETE /api/weekly/:weekStart` で行を削除。 GitHub PAT は `diary_settings` 側にあるためここでは触らない。
