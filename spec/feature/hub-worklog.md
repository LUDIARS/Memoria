# hub-worklog — 「過去やった事」 の取り込みと共有

> GitHub / ローカル git clone / Memoria 自身の活動ログを食わせて
> **やった事をリストアップし、 共有する**層の設計。
> 関連:
> - [`hub-social.md`](./hub-social.md) — worklog entry / digest は subject 化され、 コメント・いいねが付く
> - [`implementation-notes.md`](./implementation-notes.md) — 手動の「実装自慢ノート」。 worklog の手入力ソース
> - [`../data/activity.md`](../data/activity.md) — ローカルの `activity_events` (既存の取り込み先)
> - schema: [`../data/hub-social.md`](../data/hub-social.md) / API: [`../interface/hub-social.md`](../interface/hub-social.md)

## 1. 何を解決するか

「自分が過去に何をやったか」 は既にローカルに散在している —
`activity_events` (git commit / AI prompt)、 `agent_runs`、 `repo_watch`、
`implementation_notes`、 そしてローカル git clone 本体。 だが:

- **粒度が細かすぎる**。 commit 1 行では「何をやったか」 が分からない
- **一覧化されていない**。 「先月やった事」 を人に見せられる形が無い
- **共有経路が無い**。 `implementation_notes` だけが手動で Hub に出せる

なので 3 段で作る。

```
[取り込み]            [正規化]              [まとめ]              [共有]
GitHub API      ─┐
ローカル git log ─┼─► worklog_entries ──► worklog_digests ──► Hub (subject 化)
activity_events ─┤     (1 事象 1 行)      (期間 × 範囲の要約)     └─ コメント / いいね
implementation_ ─┘
notes / 手入力
```

## 2. 取り込み (ingest)

### 2.1 取り込みはローカルで走らせる

Hub には **GitHub token もローカルクローンも無い**。 だから取り込みは
必ずローカル Memoria 側で実行し、 正規化済み entry を Hub へ push する。

> Hub が直接 GitHub を叩く経路は作らない。 token を Hub に置かないため
> ([[feedback_secret_per_user_memory_only]] と同方針)。 public repo でも同じ。

### 2.2 ソース種別

| source | 取り方 | 取れるもの |
|---|---|---|
| `github` | GitHub REST/GraphQL (既存 [`repo-watch.ts`](../../server/lib/repo-watch.ts) のクライアントを流用) | commit / PR / issue / review / release |
| `git_local` | 登録済ローカルクローンに `git log --author=<self> --no-merges` | commit (未 push 分も取れる) |
| `activity` | ローカル `activity_events` | AI prompt 数 / タスク操作 (= 「どれだけ手を動かしたか」 の density) |
| `impl_note` | `implementation_notes` (`shareable=1`) | 手書きの「これを作った」 |
| `manual` | UI から直接入力 | GitHub に出ない仕事 (設計・資料・打ち合わせ) |

登録は `worklog_sources` (ローカル SQLite)。 1 行 = 1 リポ (または 1 手動スコープ) で、
**取り込み有効/無効**と**共有ポリシー** (§4) を持つ。

### 2.3 スケジュール

- 既定は **1 時間ごとの増分取り込み** (既存 `server/lib/queues.ts` の queue に載せる)
- 増分の境界は source ごとの `last_ingested_at` + provider 側の `since` パラメータ
- 手動全再取り込み (`POST /api/worklog/ingest?full=1`) は rate limit 考慮で
  repo あたり 1 回/日

## 3. 正規化 — `worklog_entries`

1 事象 = 1 行。 provider 差を吸収した共通形にする。

| 概念 | 内容 |
|---|---|
| 同一性 | `(provider, repo_key, kind, ref)` UNIQUE。 再取り込みは upsert |
| `kind` | `commit` / `pr` / `issue` / `review` / `release` / `impl_note` / `manual` |
| `ref` | commit sha / `pr/123` / `issue/45` / tag 名 / note id |
| `occurred_at` | commit author date / PR merged_at (無ければ created_at) |
| `title` | commit message 1 行目 / PR title |
| `body_md` | PR body / commit body (共有ポリシーで落ちうる、 §4) |
| `url` | html_url (Hub は本文ビューアを持たず、 元ホスティングへ飛ばす) |
| `stats_json` | `{ additions, deletions, filesChanged, commentCount }` |
| `labels_json` | PR/issue の label。 分類の手掛かり |
| `parent_ref` | commit が属する PR の ref。 畳み込みに使う (§3.1) |

### 3.1 畳み込み (roll-up)

commit をそのまま並べると「やった事」 にならない。 表示・要約の既定単位は
**PR / release**。

- `parent_ref` が埋まっている commit は既定で一覧から隠し、 PR 行の配下に畳む
- PR に属さない commit (main 直 push / ローカル未 push) は **単独行として出す**。
  隠すと実際の作業が消えるため ([[project_ludiars_no_branch_protection]] のとおり
  直 push は現実に発生している)
- `git_local` 由来の commit が後から `github` 由来の PR に紐づいたら、
  `parent_ref` を後追いで埋める (`ref` = sha が一致するので同一性は保てる)

### 3.2 重複排除

- 同じ commit が `git_local` と `github` の両方から来る → `(provider, ...)` が
  違うので別行になってしまう。 これを避けるため **`repo_key` は provider 非依存**
  (`<owner>/<name>` に正規化) にし、 UNIQUE は `(repo_key, kind, ref)` とする。
  provider は「どの経路で最初に取れたか」 を記録する情報列に格下げする
- `activity` 由来の `git_commit` イベントも同じ sha を持つので同一行に寄る

## 4. 共有ゲート — 漏らさないための機構

ここが本機能でいちばん壊れやすい。 worklog は **private repo 名・顧客名・
社内固有名がそのまま入る**。 何もしないと Hub に出た瞬間に漏れる
([[feedback_external_doc_redaction_rules]])。

### 4.1 既定は非共有

`worklog_sources.share_policy` の既定は `none`。 取り込みはしても Hub には出ない。
「ローカルで自分の実績を眺める」 だけなら Hub は不要。

| policy | Hub に出るもの |
|---|---|
| `none` (既定) | 何も出ない |
| `redacted` | repo は **alias 名**、 title は要約後の文、 body/path/branch は出さない |
| `full` | title / body / labels / stats / url まで出る |

### 4.2 `redacted` の中身

- `repo_alias` — `worklog_sources.alias` (例: `社内ツールA`)。 alias 未設定で
  `redacted` を選ぼうとしたら **設定エラーで拒否** (うっかり本名が出るのを防ぐ)
- `title` — 原文を出さず、 ローカル LLM で「固有名を含まない 1 行要約」 に置換
- `url` — 出さない (private repo の URL は 404 だが repo 名が入るため)
- `stats_json` — 出す (数値のみ)
- `labels_json` — allowlist に載ったラベルのみ

### 4.3 push 前の機械スキャン (必須ゲート)

policy を通した後、 **push する JSON 全体に禁止語スキャンをかける**。

- 禁止語辞書 = `LUDIARS/PROJECT-CODES.md` 由来の private リポ名 + 顧客名 +
  ユーザ定義の追加語 (`worklog_redaction_terms`)
- 大文字小文字無視 + 全角半角正規化 + よくある区切り (`-` / `_` / 空白) を無視して照合
- **1 件でも hit したら push 全体を中止**し、 「どの entry のどのフィールドに
  どの語が出たか」 を返す。 自動書き換えはしない (勝手に文意を変えないため)
- スキャンは push 経路の内側 (`server/worklog/redaction.ts`) に置き、
  UI からの手動 push も定期 push も同じ関数を通る。 バイパス経路を作らない

> `grep` 相当の単純照合では文字列連結や表記ゆれをすり抜ける
> ([[feedback_delegation_verification_beyond_grep]])。 スキャンは
> **正規化後の全文**に対してかけ、 テストは「連結・全角・区切り違い」 を
> 明示ケースとして持つ。

## 5. まとめ — `worklog_digests`

「過去やった事をリストアップ」 の成果物。 期間 × 範囲で 1 本のまとめを作る。

- **範囲 (scope)**: `user` (自分の全リポ) / `repo` / `topic` (label や
  キーワードで束ねた軸)
- **期間**: 週 / 月 / 任意区間
- 生成は **ローカル LLM** (Hub に LLM creds を置かない)。 入力は共有ポリシー
  適用済の entry 群 (= 出せないものは要約の材料にもしない)
- 出力: `summary_md` (何をやったか) + `highlights_json` (代表 entry の ref 配列) +
  `metrics_json` (PR 数 / commit 数 / 変更行数 / 稼働日数)
- **append-only の rev**。 同じ (scope, period) で作り直すと `rev` が増える。
  過去 rev は消さない (後から見て「その時どう総括したか」 が残る)

digest は subject 化される (`worklog_digest`) ので、 まとめに対して
コメント・いいねが付く = 「先月これやりました」 に反応が返る。

## 6. 表示

| ビュー | 内容 |
|---|---|
| タイムライン | 日付降順。 PR 単位に畳んだ既定表示 + 「commit も出す」 トグル |
| リポ別 | `repo_key` ごとの件数 + 最終活動 + digest 一覧 |
| トピック別 | label / キーワード軸。 「認証まわりをいつやったか」 |
| ヒートマップ | 日 × 件数。 `activity` 由来の density を重ねる |
| digest | 期間まとめ (rev 切替 + コメント欄) |

Multi モードでは他メンバーの worklog も同じビューで見える (共有分のみ)。
「誰が何を作ってきた人か」 が分かるのがこの機能の価値。

## 7. API

[`../interface/hub-social.md`](../interface/hub-social.md) の worklog 節に集約。
概要:

| 側 | endpoint |
|---|---|
| ローカル | `GET /api/worklog` / `GET /api/worklog/sources` / `POST /api/worklog/sources` / `POST /api/worklog/ingest` / `POST /api/worklog/digests` / `POST /api/worklog/push` |
| Hub | `GET /api/worklog` / `POST /api/worklog/entries:batch` / `GET /api/worklog/digests` / `POST /api/worklog/digests` |

## 8. プライバシー観点

- **共有レベル**: ✓ Hub-shareable (既定 `none`、 repo 単位 opt-in)
- 個人データを保持するテーブル: `worklog_entries` (誰がいつ何を書いたかの記録)。
  ローカルには全量、 Hub にはポリシー通過分のみ
- **LLM に送る情報**: `redacted` の title 要約と digest 生成でローカル LLM に
  entry の title / body を渡す。 送る先はローカル設定の provider
  ([`llm-config.md`](./llm-config.md))。 `none` policy の source も digest 生成の
  対象外にすれば LLM にも渡らない (`worklog_sources.llm_optout`)
- 削除: `DELETE /api/worklog/entries/:id` はローカル行を消す。 Hub の push 済行は
  `DELETE /api/worklog/entries/:id?remote=1` で明示的に消す (自動追随はしない)。
  subject 化されたコメントは残る (発言は他人のもの) が、 subject の title は
  「(削除済)」 に置換する

## 9. 実装フェーズ

| Phase | 内容 |
|---|---|
| 1 | ローカル `worklog_sources` / `worklog_entries` schema + `git_local` 取り込み (既存クローンから commit) + タイムライン表示 |
| 2 | `github` 取り込み (commit / PR / issue / release) + 畳み込み (`parent_ref`) + 重複排除 |
| 3 | `activity` / `impl_note` / `manual` ソース。 リポ別 / トピック別 / ヒートマップ |
| 4 | 共有ゲート — `share_policy` + alias + `redaction.ts` の禁止語スキャン + テスト |
| 5 | Hub `worklog_entries` テーブル + `POST /api/worklog/entries:batch` + push 配線 |
| 6 | `worklog_digests` (ローカル生成 → Hub push) + digest ビュー |
| 7 | subject 化 ([`hub-social.md`](./hub-social.md) Phase 2 以降) → コメント・いいね |

Phase 1-3 で「自分の実績が一覧になる」、 4-5 で「安全に共有できる」、
6-7 で「まとめに反応が付く」。

## 10. オープン論点

1. **`repo_key` の namespace 衝突** — GitHub 以外 (GitLab / 社内 Gitea) を足したとき
   `<owner>/<name>` が衝突しうる。 `host` を key に含めるか
2. **他人の commit をどう扱うか** — 既定は「自分が author の分だけ」。 レビューした
   PR や共同作業をどこまで自分の worklog に入れるか
3. **禁止語辞書の配布** — `PROJECT-CODES.md` 由来の private リポ名リストを
   どこから取るか (Castra 参照 / 手動同期 / Hub から pull)
4. **`full` policy を許すか** — 拠点ポリシーで `full` を禁止できるようにするか
   (サーバ設定で最大許容ポリシーを縛る)
5. **digest の生成主体** — 複数メンバーの worklog を横断した digest
   (= 「チームの先月」) は誰の LLM で作るか。 [`hub-dig-rooms.md`](./hub-dig-rooms.md)
   §5 の job claim と同じ仕組みに乗せるのが自然
