# トレンドクローラー

## 目的

検索・若者 (Z世代)・ニュース・テック・ゲーム・アニメ・音楽・アプリ・本・エンタメ・暮らし・海外の
12 ジャンルについて、公開されているランキング・人気一覧を定期巡回して履歴に積み、
🤖 AI タブ内の「📈 トレンド」サブビューにジャンル別で表示する。

前回の成功取得と比べた順位の動き (新登場 / ↑ / ↓ / →) と、保持期間内での初登場時刻、
別サイト同士で同じ話題が出ているもの (複数のソースで話題) を出す。巡回ごとに LLM を
1 回だけ呼び、ジャンル別の「いま何が流行っているか」を 2〜3 文でまとめる。

1 ソースの取得失敗は他を止めない。失敗したソースは前回成功分の一覧を表示したまま、
最新巡回の失敗理由だけをカードに出す。

## 構成

- `server/trend-crawler/types.ts`: ジャンル・取得方式・ソース・設定・一覧表示・要約の型。
- `server/trend-crawler/default-sources.ts`: 既定ソース (API キー不要の公開一覧のみ) を追加した版ごとに持つ。
- `server/trend-crawler/config.ts`: zod スキーマ、`app_settings` の `trend_crawler.config` / `trend_crawler.latest_summary`。
- `server/trend-crawler/schema.ts`: 履歴テーブル `trend_snapshots` / `trend_items` (openDb から呼ぶ)。
- `server/trend-crawler/store.ts`: 履歴の記録・最新 2 回の成功取得・初登場時刻・保持期間外の削除 (SQL のみ)。
- `server/trend-crawler/movement.ts`: 比較キー正規化、順位の動き、複数サイト一致の判定 (純関数)。
- `server/trend-crawler/overview.ts`: ソースごとの最新/前回比較をジャンル順に束ねた表示用一覧。
- `server/trend-crawler/summarizer.ts`: 全ジャンルを 1 つの JSON で返させる LLM (`trend_summarize`) 要約。
- `server/trend-crawler/service.ts`: 巡回手順 (取得 → 記録 → 削除 → 要約)。
- `server/trend-crawler/coordinator.ts`: 手動巡回と定期巡回をプロセス内で 1 本に直列化。
- `server/trend-crawler/scheduler.ts`: 前回巡回から `intervalHours` 経過で巡回。例外時は 30 分空ける。
- `server/trend-crawler/router.ts`: 同一端末限定の HTTP API。
- `server/trend-crawler/sources/*.ts`: 取得方式ごとの解析 (純関数) と HTTP 取得の振り分け。
- `server/public/src/trend-crawler-view.ts`: ジャンルタブ、ソース別カード、手動巡回、ソース設定 UI。

## ソース種類

| kind | 取得方法 | 指標 | 既定ソース |
|---|---|---|---|
| `rss` | RSS 1.0 (RDF) / 2.0 / Atom。並び順を順位とする | Google トレンド `ht:approx_traffic`、はてブ `hatena:bookmarkcount` | Google トレンド (JP/US)、はてブ各カテゴリ、Zenn、Product Hunt、Reddit、Google ニュース検索 |
| `apple_top` | `rss.marketingtools.apple.com` のランキング JSON。URL で国・種類・件数を指定 | なし | Apple Music、App Store 無料/有料、Apple Books、Apple Podcasts |
| `wikipedia_top` | Wikimedia `pageviews/top` の前日 (UTC) 分。未公開 (404) なら 1 日遡る | 閲覧数 | ja / en Wikipedia |
| `anilist_anime` / `anilist_manga` | `graphql.anilist.co` へ POST、`TRENDING_DESC`、`isAdult: false` | trending 値 | AniList |
| `hn_top` | Hacker News 公式 API `topstories` + 各 item | points / comments | Hacker News |

メインページ・特別ページ・名前空間付きの Wikipedia 記事は話題ではないので除く。
Google トレンドの item は link がフィード自身を指すため、最初の関連ニュースの URL を使う。

## 若者 (Z世代) ジャンル

TikTok・Instagram・X の公式トレンドは API キーが要るため、公開されている報道と掲示板から拾う。

- Google ニュースの検索結果 RSS (直近 7 日、`when:7d`): 「Z世代 トレンド」「TikTok 流行」「女子高生 流行」「若者言葉」、英語圏の "Gen Z trend"。
  検索結果は関連度順なので順位は話題の大きさではなく並び順として扱う。
- Reddit r/GenZ の今日の上位。

## 既定ソースの追加

既定ソースは追加した版 (`DEFAULT_TREND_SOURCE_RELEASES`) ごとに持つ。保存済み設定の `defaultsVersion` より
新しい版のソースだけを読み込み時に足す。利用者が消した古い既定ソースは戻さず、同じ id があれば足さない。

## HTTP API (同一端末のみ)

- `GET /api/trend-crawler/config` / `PUT /api/trend-crawler/config`
- `GET /api/trend-crawler/overview` → `{ overview, busy }`
- `POST /api/trend-crawler/refresh[?source=<id>]` → `{ result, overview }`。巡回中は 409

既存の `/api/trends/*` (保存・閲覧傾向) とは別の名前空間。

## 制約

- 個人データは扱わない。LLM へ送るのは公開ランキングの題名・補足・指標のみ。
- 利用者が URL を変えられる GET 取得は `server/shared/public-fetch.ts` (SSRF ガード) を通す。
  AniList は固定の公式エンドポイントへの POST なので通常の fetch で 2MB / 20 秒まで。
- 比較キーは NFKC・小文字化・空白と記号の除去で作る。1 文字のキーは別話題の偶然一致が多いので
  複数サイト一致に使わない。同じサイトのカテゴリ違い (はてブ総合と暮らし等) の重複は数えない。
- 1 ソースだけの手動更新では AI 要約を作り直さない。要約が JSON として読めないときは前回の要約を残す。
- 履歴は `retentionDays` (既定 30 日) より古い取得を巡回のたびに消す。
- YouTube の急上昇・X のトレンドは API キーが必要なため既定ソースに含めない。
