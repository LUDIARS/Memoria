# コード変更量の集計 (code-volume)

GitHub に載った本人のコミットから、 月ごとに「何行のコードを変更したか」 を集計し、
Villa で配信する単一 HTML (と JSON) を書き出す CLI。

## 使い方

```bash
cd server
npm run code-volume -- \
  --months 2024-02,2024-09,2025-02,2025-09,2026-02,2026-09 \
  --author nyangame --author-email revisor@localhost \
  --out ../../Villa/code-volume.html --json ../data/code-volume/report.json
```

| 引数 | 意味 |
|---|---|
| `--months` | 集計する月 (`YYYY-MM`、 カンマ区切り)。 必須 |
| `--author` | GitHub login (`author:` 検索)。 繰り返し可 |
| `--author-email` | コミットの author email (`author-email:` 検索)。 Revisor の squash など GitHub ユーザーに紐づかないコミット用 |
| `--out` / `--json` | 出力先。 省略時は標準出力に月ごとの値だけ出す |
| `--cache` | 取得済みコミットのキャッシュ。 既定 `data/code-volume/commits.json` (git 管理外) |
| `--exclude-repo` | 除外するリポ (`owner/name`) の正規表現 |

token は `MEMORIA_GH_TOKEN` → `GITHUB_TOKEN` → `gh auth token` の順に探す。 無ければ未認証で呼ぶ (private リポは取れない)。

## 数え方

- 対象は GitHub のコミット検索に当たる、 merge 以外のコミット。 検索は既定ブランチに載ったものしか返さないので、 「push されて既定ブランチに入ったもの」 だけが数に入る。
- 変更行 = 追加行 + 削除行 (コミット詳細 API の値)。
- 「コード」 はソース拡張子のファイルに限り、 `node_modules` / `dist` / `build` / `vendor` / `third_party` / `generated` / `report` / `artifacts` / `sdk` 等とロックファイルを除く (`server/code-volume/file-filter.ts`)。 キャッシュはファイル別の変更行を持ち、 判定は集計時に行うので、 判定を変えても再取得は要らない。 「全ファイル」 は除外なし。
- 月の境界は JST。 検索は UTC 日付なので前後 1 日を足して引き、 集計時に JST の月で振り分ける。
- 週平均 = 月合計 ÷ (その月の日数 ÷ 7)。 全体の週平均は選んだ月の合計 ÷ (総日数 ÷ 7)、 月平均は選んだ月数で割る。

## 制約

- GitHub 検索は 1 クエリ 1000 件まで。 週単位の窓で引き、 超えたら日単位に割る。 1 日でも超えた場合は取りこぼしとして HTML に出す。
- コミット詳細のファイル一覧は 3000 件で切れる。 切れたコミットはコード行が下限値になり、 件数を HTML に出す。
- 検索 API の rate limit (認証時 30 回/分) とコア API (5000 回/時) は reset まで待って再試行する。 初回は詳細取得がコミット数ぶん走るが、 2 回目以降はキャッシュから読む。

## 構成 (`server/code-volume/`)

| ファイル | 責務 |
|---|---|
| `period.ts` | 月・日数・検索窓 (純関数) |
| `file-filter.ts` | コードファイル判定 (純関数) |
| `aggregate.ts` | 月集計と平均 (純関数) |
| `github-commits.ts` | GitHub REST adapter (検索・詳細・rate limit) |
| `cache.ts` | 取得済みコミットの JSON キャッシュ |
| `collect.ts` | 収集の use case (検索 → 未取得分だけ詳細) |
| `render-html.ts` | Villa 用の単一 HTML |
| `cli-args.ts` | CLI 引数 |

CLI 本体は `server/scripts/code-volume.ts`。 他ドメインへの import は無い。
