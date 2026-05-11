# weekly — 週次レポート

## 概要
週単位 (日曜 23:05 cron) で 7 日分の日記をまとめて Opus 1M に渡し、 **冒頭に定量サマリ + LLM が生成する短いナラティブ**を生成する。 月ベースで `週 N` をラベル付け。

## ユースケース
- 1 週間の振り返り / 月次 KPI の素材
- 「先週のハイライトを LinkedIn 投稿用に」 みたいな引用元
- 月の中の `week_in_month` で N 週目を示せる
- 週合計の作業時間 / コミット / ブックマーク数を一目で確認

## 画面 / 入口
- `📅 日記` タブ → 月の上部 / 下部に週次レポート行
- 手動再生成 `POST /api/weekly/:weekStart/generate`

## データ
- [weekly_reports](../db/diary.md) — week_start (PK) / week_end / month / week_in_month / summary / github_summary_json / status
- 集計参照:
  - [diary_entries](../db/diary.md) (`work_minutes` の合計を週作業時間として記載)
  - [bookmarks](../db/bookmark.md) (`created_at` を週で count)
  - [visit_events](../db/visit.md) (`visited_at` を週で count)
  - [activity_events](../db/activity.md) (`kind='git_commit'` のローカル commit hook 件数 + `kind='claude_code_prompt'` の指示件数を week で count)
  - GitHub API (per-repo commits API、 `diary_settings.github_repos` で対象を絞る)

## 出力フォーマット (rev2)
週次レポートの `summary` は以下の構造を持つ:

```markdown
# 週報 YYYY-MM-DD 〜 YYYY-MM-DD

## 今週の定量サマリ
- ⏱ 作業時間 (Sonnet 推定の週合計): X 時間 Y 分
- 🔖 ブックマーク新規追加: N 件
- 🌐 Web 訪問 (記録分): N 件
- 🐙 GitHub commit: N 件 (API 取得)
- 💻 ローカル commit (hook): N 件
- 🤖 Claude Code 指示: N 件

## 今週やったこと
(LLM 出力、 2-3 文以内の超簡潔サマリ)

## 主な成果
- (LLM 出力、 各行は **(N commit)** prefix で commit 数を必ず含める。 上位 5 件)

## トピック別
- (LLM 出力、 1-3 行)

## 来週への引き継ぎ
- (LLM 出力、 1-3 行)
```

**冒頭の「今週の定量サマリ」 は決定論的に生成**(server/diary.ts の `formatTotalsHeader`)、 LLM が触れることはない。 LLM はそれ以下の 4 セクションを書くが、 各成果行に commit 数を埋め込ませるためプロンプトで定量サマリを文脈として渡している。 全体で 300-500 字程度に収める指示を含む。

## API
- [diary.md](../api/diary.md) — `/api/weekly` (月一覧) / `/api/weekly/:weekStart` / `/api/weekly/:weekStart/generate` / `DELETE /api/weekly/:weekStart`

## シェア可能か
**local-only**

週次レポートを Hub にシェアする経路は無い。 日記と同じ理由で意図的に local-only。

## プライバシー観点
- **個人データを保持するテーブル**: `weekly_reports` (1 週間の生活ログ高度集約)。 定量サマリには 1 週間の作業時間 / アクティビティ件数が露出する。
- **LLM プロバイダに送る情報**: タスク `diary_weekly` (Opus 1M default) に 7 日分の日記 summary / work_content + 各日の work_minutes + GitHub commit 集計 + 定量サマリを渡す。 個人情報量は日記生成時の prompt より大きい。
- **共有時に外部に出ない情報**: 週次レポート全体。
- **削除時の挙動**: `DELETE /api/weekly/:weekStart` で行を削除。 GitHub PAT は `diary_settings` 側にあるためここでは触らない。
