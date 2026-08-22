# 更新クローラー

## 目的

Codex CLI、Claude Code、Unity、Unreal Engine、Git など、登録した公式サイトの
更新履歴を毎日巡回し、ソースごとに直近 N バージョン (既定 5) の変更点を
日本語で簡潔にまとめて 🤖 AI タブ内の「🔄 更新クローラー」サブビューに表示する。

要約は 1 バージョンにつき 1 回だけ LLM に掛け、前回 digest に同じ version が
あれば再利用する。取得に失敗したソースは前回の表示を残し、失敗理由だけを
カードに出す (画面から消えない)。

## 構成

- `server/release-watch/types.ts`: ソース / 生エントリ / 要約済みエントリ / digest の型。
- `server/release-watch/config.ts`: zod スキーマ、既定ソース、`app_settings` への設定と digest の保存。
- `server/release-watch/github-source.ts`: GitHub Releases API、GitHub Tags API + リリースノート URL テンプレ。
- `server/release-watch/rss-source.ts`: RSS 2.0 / Atom feed の正規化。
- `server/release-watch/html-source.ts`: RSS も API も無い公式ページの本文を LLM (`release_extract`) でバージョン一覧に抽出。
- `server/release-watch/summarizer.ts`: 1 バージョンの変更点を LLM (`release_summarize`) で日本語 3〜6 行に要約。
- `server/release-watch/service.ts`: ソース種類で取得を振り分け、要約キャッシュを突き合わせて digest を組む。
- `server/release-watch/coordinator.ts`: 手動更新と日次巡回をプロセス内で 1 本に直列化。
- `server/release-watch/scheduler.ts`: 毎日 `refreshHour` 以降に 1 回、失敗時は 30 分おきに再試行。
- `server/release-watch/router.ts`: 同一端末限定の HTTP API。
- `server/shared/public-fetch.ts`: redirect ごとに public URL を検証する SSRF ガード付きテキスト取得。
- `server/public/src/release-watch-view.ts`: ソース別カード、手動巡回、監視サイト設定 UI。

## ソース種類

| kind | 取得方法 | 既定ソース |
|---|---|---|
| `github_releases` | `api.github.com/repos/<o>/<r>/releases` (draft 除外、 `includePattern` で rc 等を除外) | Claude Code、 Codex CLI |
| `github_tags` | `api.github.com/repos/<o>/<r>/tags` + `notesUrlTemplate` (`{tag}` / `{version}` 置換) | Git (`Documentation/RelNotes/{version}.adoc`) |
| `rss` | RSS 2.0 / Atom | Unity LTS (`unity.com/releases/editor/lts-releases.xml`) |
| `html` | ページ本文 → `release_extract` で JSON 抽出 | Unreal Engine (JS 描画のため本文が取れない場合は失敗として表示) |

GitHub API は無認証だと 60 req/h。 `MEMORIA_GITHUB_TOKEN` (または `GITHUB_TOKEN`) が
あれば Bearer で付与する。 付与先は `api.github.com` に限る (`notesUrlTemplate` は任意ホストを
指せるため、 トークンを第三者サイトへ送らない)。 redirect で origin が変わった場合も引き継がない。

`rss` の本文補完 (`releaseNotesLink` / item link の追加取得) は、 1 件ごとに追加の HTTP 取得が
走るため新しい方から 3 件までに絞る。

## HTTP API (同一端末のみ)

- `GET /api/release-watch/config` / `PUT /api/release-watch/config`
- `GET /api/release-watch/digest` → `{ digest, busy }`
- `POST /api/release-watch/refresh[?source=<id>]` → 巡回中は 409

## 制約

- 個人データは扱わない。 外部へ送るのは公式ページの本文のみ (LLM 要約経路は他タスクと同じ `runLlm`)。
- 取得は 4MB / 30 秒 / redirect 5 回まで。 private / loopback 宛ては `assertPublicHttpUrl` で拒否。
- digest は `app_settings` の `release_watch.latest_digest` 1 行に JSON で保存 (ソース 40 × 10 版まで)。
- digest の `date` は「全ソースを巡回し切った日」。 `?source=<id>` の個別更新では進めない (null
  または前回値のまま)。 ここを進めると scheduler の当日判定が残りのソースの日次巡回を止めてしまう。
