# RSS リーダー + トレンド取り込み + 自分専用 Discover

略称 Mm / 実装: `server/rss/` + `server/routes/rss.ts` + `server/public/src/rss-view.ts`

## 目的

3 つを 1 つのタブ (📡 RSS) に統合する:

1. **RSS リーダー** — 任意の RSS / Atom フィードを登録して記事を一覧表示する。
2. **トレンド取り込み** — はてなブックマーク人気エントリー / Google トレンド (急上昇ワード)
   を RSS 経由で取り込み、 世の中の熱量の変化 (マクロトレンド) を可視化する。
3. **自分専用 Discover** — ユーザが「興味テーマ」 を宣言すると、 AI (Feedly Leo 風) が
   全記事を 0.0〜1.0 で採点し、 好みの記事だけが上位に集まる「自分専用 Discover」 を作る。
   = 未来予測のための情報収集基盤の土台。

## データモデル (SQLite)

`server/rss/schema.ts` の `ensureRssSchema(db)` で作成 (openDb の末尾から呼ぶ)。

- **rss_feeds** — 登録フィード。 `kind` = `rss` | `hatena` | `google_trends`。
  `enabled` で定期取得 ON/OFF、 `last_status`/`last_error` で取得結果を保持。
- **rss_articles** — 取り込んだ記事。 `(feed_id, guid)` で一意 (重複取り込み防止)。
  `ai_score` / `ai_reason` / `ai_matched` / `ai_status` (pending/done/skip/error) で
  パーソナライズ採点を保持。 `meta_json` に Google トレンドの検索ボリューム + 関連ニュースを格納。
- **rss_interests** — AI Feeds テーマ。 `label` + `prompt` (どんな記事を見たいか) + `weight`。
- 設定は `app_settings` の `rss.*` キー (`enabled` / `poll_interval_minutes` /
  `auto_score` / `min_score_notify` / `notify_enabled`)。

## パイプライン

`server/rss/poll.ts`:

```
pollAllFeeds(db)              # 定期 tick / 手動更新の入口 (多重起動ガードあり)
  └ pollFeed(db, feedId)      # fetchFeedXml → parseFeedXml → upsertArticle (新着のみ)
  └ scorePendingArticles(db)  # auto_score 時、 pending 記事を直列に AI 採点
  └ notifyTopArticles(db)     # notify_enabled 時、 閾値以上の新着を push (重複通知なし)
```

- **取得**: `server/rss/sources.ts#fetchFeedXml` (XML content-type を許容、 5MB 上限)。
- **パース**: `server/rss/parse.ts` が fast-xml-parser で RSS 2.0 / Atom / RDF(RSS1.0) /
  Google トレンド (`ht:` 名前空間) を中立的な `ParsedArticle[]` に正規化。
  - Google トレンドは item に個別 link/guid が無いため、 急上昇ワード (title) で一意化し、
    遷移先は関連ニュース URL or キーワード検索にする。
  - `processEntities:false` + 自前 entity デコード (16進数値参照含む) で
    はてブの大量エンティティによる billion-laughs ガード誤検知を回避。
- **採点**: `server/rss/score.ts#scoreArticle` が有効な興味テーマと記事を
  `runLlm({ task:'rss_score' })` (既定 haiku) に渡し、 `{score, matched, reason}` を得る。
  興味テーマが 0 件なら採点せず `skip` (= 通常の時系列 RSS リーダーとして動く)。

## 定期実行

`server/lib/scheduler.ts#startRssPollInterval` が 1 分ごとに tick し、
`rss.poll_interval_minutes` (既定 30 分) 経過していれば `pollAllFeeds` を呼ぶ。
`rss.enabled=false` でスキップ。 起動 45 秒後に初回。

## HTTP API (`/api/rss/*`)

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/rss/presets` | ワンクリック登録プリセット (Google トレンド / はてブ) |
| GET/POST | `/api/rss/feeds` | フィード一覧 / 追加 (kind 自動判定 + 初回取得をキック) |
| PATCH/DELETE | `/api/rss/feeds/:id` | 有効化・カテゴリ変更 / 削除 |
| POST | `/api/rss/feeds/:id/refresh` | 単一フィードを今すぐ取得 |
| POST | `/api/rss/refresh` | 全フィードを取得 → 採点 → 通知 |
| GET | `/api/rss/articles` | 記事一覧 (sort=score/published, min_score, unread, starred, category, kind) |
| POST | `/api/rss/articles/:id/read` `/star` `/score` | 既読 / スター / 単記事再採点 |
| GET/POST/PATCH/DELETE | `/api/rss/interests[/:id]` | 興味テーマ CRUD |
| POST | `/api/rss/rescore` | 興味テーマ変更後に全記事を再採点 (非同期) |
| GET/PATCH | `/api/rss/settings` | RSS 設定 |

## フロントエンド

`server/public/src/rss-view.ts` (app.ts から `loadRssView()` を呼ぶ自己完結モジュール)。
サブビュー: **ディスカバー** (スコア順) / **新着** (時系列) / **スター** / **フィード** /
**興味テーマ** / **設定**。 記事カードはスコアバッジ + AI 理由 + (トレンドは) 検索ボリューム
と関連ニュースを表示。

## v2 追加機能 (フィード拡充 + 要約 + おすすめ)

### フィードを増やす
- **プリセットカタログ拡充** (`sources.ts#FEED_PRESETS`) — トレンド/テック/ニュース/
  ビジネスのカテゴリで代表ソースを多数登録 (はてブ各カテゴリ / Publickey / Zenn /
  Hacker News / GIGAZINE / NHK / TechCrunch 等)。 自由に追記できる。
- **フィード自動発見** (`sources.ts#discoverFeeds`) — サイト URL を投げると HTML の
  `<link rel="alternate" type="application/rss+xml|atom+xml">` を走査して登録候補を返す。
  URL 自体がフィードならそれを採用。 `POST /api/rss/discover`。

### 記事の AI 要約 (`summarize.ts`)
- 記事ページ本文を取得 → タグ除去 → `runLlm({ task:'rss_summarize' })` (既定 haiku) で
  2-3 文に圧縮し `rss_articles.ai_summary` に保存。 本文取得失敗時はフィード summary +
  タイトルで代替。 `POST /api/rss/articles/:id/summarize` (手動) / 設定 `auto_summarize`
  ON で取得時に高スコア新着を自動要約。

### おすすめダイジェスト (`digest.ts`)
- 直近 36h の上位記事 (スコア優先) を `runLlm({ task:'rss_digest' })` (既定 sonnet) で
  「今日の注目ポイント + ピックアップ + その他」 の Markdown ブリーフィングに合成。
  日付単位で `rss_digests` にキャッシュ。 `GET /api/rss/digest` (取得) /
  `POST /api/rss/digest` (生成・再生成)。 フロントは ダイジェストサブビューで Markdown 描画。

## v3 Discord 連携 + ニュース化

- トップタブ表記を **「📰 ニュース」** に変更 (内部 `data-tab` は `rss` のまま)。
- **Discord 投稿** — 「今日のダイジェスト」 + 「気になるニュース (トレンド検知=
  Google トレンド / はてブ系フィードの直近上位)」 を Discord の `#news` チャンネルへ。
  - `server/discord/news.ts` がアダプタ。 rss の `getOrCreateDigest` + `listTrendingArticles`
    を呼んで整形し `postToChannel(client, db, 'news', …)` で送信 (2000 字制限で分割)。
  - `client.ts` の ready で `startNewsScheduler` 起動 → 毎日 `features.discord.news_hour`
    時 (既定 8 時) に 1 回自動投稿 (`features.discord.news_last_sent` で重複防止)。
  - 設定フラグ `features.discord.news` (既定 true)、 `desiredChannels` に `news` を追加。
  - 手動投稿: `POST /api/rss/discord-post` → `postRssNewsNow(db)` (Bot 未接続なら 502)。
    Memoria の ニュース→設定 に「📨 Discord に今すぐ投稿」 ボタン。
- プリセット拡充: Zenn / Qiita人気 / Publickey / ITmedia NEWS / ＠IT / 企業テックブログ
  まとめ / Hacker News / NHK / はてブ総合 / Reddit r/technology / Google ニュース検索 /
  Google トレンド 等。

## 設計判断 / 既知の制約

- `server/rss/` は他ドメインへ依存せず (`llm.ts`/`push.ts` の共有インフラのみ)、
  将来 `mv server/rss/ ../rss-service/` で切り出せる境界に保つ (CLAUDE.md の方針)。
- 採点は直列実行 (LLM CLI の一斉起動を避ける)。 大量フィード時はレイテンシより
  安定を優先。 将来必要なら `lib/queues.ts` の FifoQueue へ寄せる。
- 個人データはローカル SQLite に閉じる ([[project_personal_data_rule]])。
  フィード取得は外部 HTTP だが、 取り込んだ記事は手元 DB のみ。
- 「API とRSS」 のうちトレンド系 (Google トレンド / はてブ) は公式 RSS で充足。
  追加の API 連携 (Feedly/Inoreader、 Make/Zapier 経由の Notion 転送等) は将来拡張。
