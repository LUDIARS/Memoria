# 開発量の日次集計 (dev-throughput)

## 目的

「最近 1 日に Revisor で何件マージし、 何件コミットしたか」 を日ごとに Memoria で確認できるようにする
(neco 2026-10-14)。 📒 作業記録タブの「📊 開発量」に、 直近 30 日を新しい順の表で出す。
各日に Rv マージ件数・コミット件数 (棒と数値)・マージの多いリポ上位 3 件、 上部に期間合計と 1 日平均を出す。

## 数え方

- **コード追加行数**: コミット件数と同じ org・JST の committer-date を使い、`merge:false` の検索結果を repository/SHA で重複排除する。コミット詳細のファイル別 `additions` のうち、共有 `server/shared/code-file-filter.ts` がソースと判定するファイルだけを合計する。削除行は差し引かない。生成物・同梱ライブラリ・ドキュメントは除外する。手入力の打鍵量ではなく、GitHub に記録された追加行数であり、AI による追加も含む。
- コード追加行数は日別の棒・数値と期間合計・集計済み日の平均を表示する。未取得は `null` / `—`。一部だけ集計済みなら集計済み日数を示す。
- コード追加行数も今日・昨日と未集計日を再取得する。検索は100件ずつ、詳細は100ファイルずつ取得し、repository/SHAごとの結果をSQLiteへキャッシュする。検索1000件超・不完全な検索・詳細3000ファイル上限・HTTP失敗はその日を確定せず、エラー表示して次の定期集計で再試行する。以前の確定値は失敗時に保持する。
- SQLite既存テーブルへnullableの`code_additions`列を冪等追加する。`dev_throughput_code_cache_v1`は分類ルール版を含むコミットキャッシュ。分類変更時には版を更新し日次値の再集計も行う必要がある。
- GitHub APIの契約: [コミット詳細](https://docs.github.com/en/rest/commits/commits#get-a-commit)、[コミット検索](https://docs.github.com/en/rest/search/search#search-commits)。認証で読めるリポジトリだけが対象。未認証ではprivateを含まない。遅れて反映された古いコミット（昨日より前）は自動で再集計しない既存の制約を維持する。

- 1 日 = 日本時間 (JST) の 0:00〜23:59:59。
- **Rv マージ**: Revisor の `GET /v1/local-prs?view=summary&state=merged` (接続先は Excubitor が配る `REVISOR_URL`)
  を 1 回読み、 マージ済み PR の `updatedAt` の JST 日付で数える。 summary はマージ時刻を持たないので、
  マージ後に記録が更新された PR は後ろの日へずれることがある (2026-10-14 の実測では lifecycle の merged 時刻で
  数えた値と一致した)。 リポ (`owner/name`) ごとの内訳も保存する。
- **コミット**: GitHub のコミット検索 `org:LUDIARS committer-date:<JST の 1 日>` の `total_count`。
  検索は既定ブランチに載ったコミットだけを返すので、 push されて既定ブランチに入ったものだけが数に入る。
  Revisor の squash マージも 1 コミットとして入る。 org は `DEV_THROUGHPUT_GITHUB_ORG` で変えられる (既定 `LUDIARS`)。
- token は `MEMORIA_GH_TOKEN` → `GITHUB_TOKEN` → `gh auth token` の順に探す。 無いと private リポは数に入らない。

## 収集

- サーバ起動時に 1 回、 以後 1 時間ごと。 画面の「今すぐ集計」(`POST /api/dev-throughput/sync`) でも走る。 同時に走るのは 1 本だけ。
- マージ件数は直近 30 日を毎回数え直して上書きする (0 件の日も保存する)。
- コミット件数は今日・昨日 (遅れて push されたコミットで増える) と、 まだ数えていない日だけ聞き直す。
  検索 API は認証時 30 回/分なので 2.5 秒ずつ空ける。 403/429 が返ったらそこで止めて次の回に回す。
- Revisor と GitHub は独立に扱い、 片方が失敗してももう片方は保存する。 失敗は画面の「最終集計」の横に出す。

## API

| | |
|---|---|
| `GET /api/dev-throughput?days=30` | 直近 N 日 (新しい順、 1〜90、 既定 30)。 未集計の日は件数 `null`。 `sync` に集計状態 |
| `POST /api/dev-throughput/sync` | 集計を始める (完了は待たない、 202) |

どちらも同じ端末からだけ使える (`isSameMachineRequest`)。

## 構成

| ファイル | 責務 |
|---|---|
| `server/dev-throughput/jst-day.ts` | JST の暦日・直近 N 日・検索範囲 (純関数) |
| `server/dev-throughput/count-merges.ts` | マージ済み PR を日とリポで数える (純関数) |
| `server/dev-throughput/revisor-merges.ts` | Revisor の一覧を読む adapter |
| `server/dev-throughput/github-commit-count.ts` | GitHub 検索で 1 日のコミット件数を数える adapter |
| `server/dev-throughput/github-token.ts` | GitHub token の解決 |
| `server/dev-throughput/store.ts` | `dev_throughput_daily` テーブル (1 日 1 行) |
| `server/dev-throughput/collect.ts` | 収集の use case |
| `server/dev-throughput/sync-coordinator.ts` | 実行の単一化・状態・定期実行 |
| `server/dev-throughput/router.ts` | HTTP 口と組み立て |
| `server/public/src/dev-throughput-view.ts` | 「📊 開発量」の表示 |

コードファイル判定は `shared/code-file-filter` を月次レポートと共有し、domain間の直接importを持たない。`github-code-additions.ts`は日別の追加行数取得、`code-additions-store.ts`はその保存・スキーマ更新を所有する。

## 制約

- 保存は Memoria の SQLite。 Revisor が古い PR を消しても、 保存済みの日の値は残る (直近 30 日は毎回上書き)。
- GitHub 検索は fork と既定ブランチ以外のコミットを数えない。 ローカルだけにあるコミットも数えない。
