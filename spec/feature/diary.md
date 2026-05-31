# diary — 日次自動日記

## 概要
1 日 1 行の自動生成日記。 ブラウジング / dig / GitHub commit / activity_events / GPS / 食事を集約し、 Sonnet が「作業内容」、 Opus 1M が「全体サマリ」 + 「ハイライト」 を生成。 ユーザの `notes` 欄は手動で追記可能。

## ユースケース
- 「昨日何やったっけ」 を 30 秒で振り返る
- ハイライト + GitHub commit でいつ何を書いたか辿る
- タスクの開始 / 完了が自動で `notes` に追記される (`appendTaskDiaryLog`)
- 任意の追加指示 (`improve`) を 1 度だけ流して再生成

## 画面 / 入口
- `📅 日記` タブ → 月別カレンダー → 日付クリックで詳細
- 詳細パネル: live_metrics / summary / work_content / highlights / notes / `生成` ボタン
- ページング: `/api/diary/:date/bookmarks` `/api/diary/:date/digs` (1 日のブクマ / dig が多いと WebView がフリーズするため分離)

## データ
- [diary_entries](../data/diary.md) — date (PK) / summary / work_content / highlights / notes / metrics_json / github_commits_json / work_minutes / status
- [diary_settings](../data/diary.md) — GitHub PAT / user / repos の key/value (`app_settings` ではなく専用テーブル)
- 集計参照: [activity_events](../data/activity.md), [page_visits / visit_events](../data/visit.md), [bookmarks / accesses](../data/bookmark.md), [dig_sessions](../data/dig.md), [meals](../data/meal.md), [gps_locations](../data/gps.md)
- サイドカー: 太い `metrics_json` / `github_commits_json` は `<DATA>/diary/<date>.json` に切り出し (`migrateDiariesToSidecar`)

## API
- [diary.md](../interface/diary.md) — `/api/diary*` (月一覧 / 詳細 / 生成キュー / 編集 / 削除) / `/api/diary/settings` / `/api/diary/test-github` / `/api/diary/:date/bookmarks` / `/api/diary/:date/digs`

## シェア可能か
**local-only**

日記そのものは Hub にシェアできない (`/api/multi/share` 対象外)。 個人の生活ログ全集約のため、 共有路を意図的に持たせていない。

## プライバシー観点
- **個人データを保持するテーブル**: `diary_entries` (個人情報密度が最高クラス: その日の作業内容 + ハイライト + 自由記述メモ)、 `diary_settings` (GitHub PAT を含む)。 サイドカー JSON も同等。
- **LLM プロバイダに送る情報**: `diary_work` (Sonnet) には当日の URL タイムライン + 作業時間概算、 `diary_highlights` (Opus 1M) と `diary_weekly` (Opus 1M) には日記サマリ + dig + bookmark + commit + 食事 + GPS 集計を含む。 ユーザの GitHub PAT は LLM には送らず、 サーバから GitHub API 直叩きで commit を取得した結果のみ送る。
- **共有時に外部に出ない情報**: 日記全体 (シェア対象外)。
- **削除時の挙動**: `DELETE /api/diary/:date` で行を削除。 元データ (bookmarks / activity_events / etc.) は削除しないので、 再生成すれば近い内容が戻る (notes は失われる)。 `diary_settings.github_token` は API patch で空文字を送ることで消える。
