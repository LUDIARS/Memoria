# diary — 日次自動日記

## 概要
1 日 1 行の自動生成日記。 ブラウジング / dig / GitHub commit / activity_events / GPS / 食事を集約し、 Sonnet が「作業内容」、 Opus 1M が「全体サマリ」 + 「ハイライト」 を生成。 ユーザの `notes` 欄は手動で追記可能。

## ユースケース
- 「昨日何やったっけ」 を 30 秒で振り返る
- ハイライト + GitHub commit でいつ何を書いたか辿る
- タスクの開始 / 完了が自動で `notes` に追記される (`appendTaskDiaryLog`)
- 任意の追加指示 (`improve`) を 1 度だけ流して再生成
- 外部サービスがその日のまとめを「外部節」 として書き込む (例: Concordia のデイリーゴール自走が毎朝 4:00 に前日分を `concordia-daily-goal` 節へ PUT)

## 画面 / 入口
- `📅 日記` タブ → 月別カレンダー → 日付クリックで詳細
- 詳細パネル: live_metrics / summary / work_content / highlights / notes / `生成` ボタン
- 外部節: notes の下に `title` 見出し + Markdown 本文で表示 (`server/public/src/diary-sections-view.ts`)。 編集 UI は持たず、 削除ボタンだけ
- ページング: `/api/diary/:date/bookmarks` `/api/diary/:date/digs` (1 日のブクマ / dig が多いと WebView がフリーズするため分離)

## データ
- [diary_entries](../data/diary.md) — date (PK) / summary / work_content / highlights / notes / metrics_json / github_commits_json / work_minutes / status
- [diary_settings](../data/diary.md) — GitHub PAT / user / repos の key/value (`app_settings` ではなく専用テーブル)
- 集計参照: [activity_events](../data/activity.md), [page_visits / visit_events](../data/visit.md), [bookmarks / accesses](../data/bookmark.md), [dig_sessions](../data/dig.md), [meals](../data/meal.md), [gps_locations](../data/gps.md)
- サイドカー: 太い `metrics_json` / `github_commits_json` は `<DATA>/diary/<date>.json` に切り出し (`migrateDiariesToSidecar`)
- [diary_sections](../data/diary.md) — 外部節。 `(date, source)` が PK。 `diary_entries` と独立 (`server/diary/sections-store.ts`)

## 外部節 (external sections)

外部サービスが日記の一部を書く口。 `PATCH /api/diary/:date` はユーザメモ `notes` を丸ごと置き換えるため外部書き込みには使わない。

- `PUT /api/diary/:date/sections/:source` は `(date, source)` の節を置き換える (無ければ作る)。 `diary_entries` の他欄 (summary / work_content / highlights / notes) は変えない。 日記行が無い日でも行は作らず節だけ保存する
- `date` は `YYYY-MM-DD`、 `source` は `[a-z0-9-]{1,64}`。 `title` は 1〜200 字、 `markdown` は空でなく 200KB (UTF-8) 以下。 違反は 400
- 書き込み (PUT / DELETE) は同一端末からだけ受ける (`isSameMachineRequest` + `Sec-Fetch-Site` が same-origin / none)。 遠隔 socket や別 Origin は 403
- 日記の再生成 (`/api/diary/:date/generate`) は外部節を消さない。 日記の LLM 生成 (work / highlights / weekly) に外部節は渡さない (表示と保存のみ)
- 呼び出し側: Concordia `spec/feature/daily-goal-run.md` の「Memoria との契約」 (`source=concordia-daily-goal`)。 ノート側は [local-tabula.md](local-tabula.md) の `POST /api/notes/from-text`

## API
- [diary.md](../interface/diary.md) — `/api/diary*` (月一覧 / 詳細 / 生成キュー / 編集 / 削除) / `/api/diary/settings` / `/api/diary/test-github` / `/api/diary/:date/bookmarks` / `/api/diary/:date/digs` / `/api/diary/:date/sections*`

## シェア可能か
**local-only**

日記そのものは Hub にシェアできない (`/api/multi/share` 対象外)。 個人の生活ログ全集約のため、 共有路を意図的に持たせていない。 外部節 (`diary_sections`) も同じく local-only。

## プライバシー観点
- **個人データを保持するテーブル**: `diary_entries` (個人情報密度が最高クラス: その日の作業内容 + ハイライト + 自由記述メモ)、 `diary_settings` (GitHub PAT を含む)、 `diary_sections` (外部サービスが書いたその日のまとめ)。 サイドカー JSON も同等。
- **LLM プロバイダに送る情報**: `diary_work` (Sonnet) には当日の URL タイムライン + 作業時間概算、 `diary_highlights` (Opus 1M) と `diary_weekly` (Opus 1M) には日記サマリ + dig + bookmark + commit + 食事 + GPS 集計を含む。 ユーザの GitHub PAT は LLM には送らず、 サーバから GitHub API 直叩きで commit を取得した結果のみ送る。
- **共有時に外部に出ない情報**: 日記全体 (シェア対象外)。
- **削除時の挙動**: `DELETE /api/diary/:date` で行と、 その日の外部節 (`diary_sections`) を同じトランザクションで削除。 外部節は 1 件ずつ `DELETE /api/diary/:date/sections/:source` でも消せる。 再生成 (generate) は外部節を消さない。 元データ (bookmarks / activity_events / etc.) は削除しないので、 再生成すれば近い内容が戻る (notes は失われる)。 `diary_settings.github_token` は API patch で空文字を送ることで消える。
