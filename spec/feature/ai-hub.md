# AI ハブ (🤖 AI タブ)

## 概要

Memoria の AI 関連機能を 1 つの「🤖 AI」タブに集約し、毎朝 6:00 に前日の作業から技術記事を自動生成する。AI が「おすすめ・記事・アドバイス」を出す場所を 1 箇所にまとめる。

2 つの自動ジョブ + 1 つの集約 UI からなる:

1. **記事ダイジェスト** — 毎朝 6:00、前日の `activity_events`(主) + session-log(補助) から記事化できるトピックを抽出。お気に入り最大 3 本を本記事化して「AI記事」に記録。残りは「記事ネタ」として 📝 ログタブに出し、ユーザが「記事化を依頼する」を押すとオンデマンドで本記事化。
2. **AIアドバイス** — 毎朝 6:00、直近 1 週間の 日記・ニュース・傾向・おすすめ・タスク のデータを LLM に投入して助言を生成。AI タブに表示。
3. **🤖 AI タブ** — おすすめ / AI記事 / AIアドバイス を束ねる。

## ユースケース

- 朝起きたら、昨日の自分の作業が技術記事になっている。気に入ったらノートに転写して公開素材にする。
- 記事にするほどでもないネタは「記事ネタ」に溜まり、後で気が向いたら記事化を依頼する。
- 1 週間の生活・作業データから、AI が「次にこうしたら」という助言をくれる。

## 画面 / 入口

### 新タブ「🤖 AI」(data-tab="ai")
サブタブ:
- **✨ おすすめ** (既存 recommend ビューをこの配下へ移動)
- **📰 AI記事** (ai_articles 一覧。各記事: タグ chips + 表示 / 📓ノートへ転写 ボタン。先頭に **フィルタバー**=対象日(for_date)範囲 + タグ category 別 chips。日付・タグで AND 絞り込み)
- **📝 記事ネタ** (`ai_article_seeds` の status='pending' を一覧。各行: 記事化を依頼する / 却下)
- **💡 AIアドバイス** (最新の ai_advice を表示 + 「今すぐ生成」)

> 記事ネタは当初 📝 ログ(worklog)タブ配下に置いたが、AI 由来コンテンツの一元化のため 🤖 AI タブ配下へ移設した (worklog の seeds サブタブ/コンテナは廃止)。

### 既存タブの整理
- **「✨ 実装自慢」を完全削除** (subtab spec の 'impl' エントリ、implView/simple-panel、implEditorModal、関連 load/render/handler を全て除去)。
- **「📋 作業一覧」(worklist = リポジトリ監視ダッシュボード) を「📦 プロジェクト」に改名し、🗄 データベースのサブタブ (data-db-sub="projects") へ移動**。トップレベルの worklist タブは削除。中身 (loadRepoWatch / repoList) はそのまま。
- **トップレベルの「✨ おすすめ」タブは削除** (AI 配下へ移動済みのため)。

### 📅 日記タブに「さかのぼり AIノート生成」を追加
- 日記がある日について、その日の作業ログ (activity_events + session-log) から既存 digest を走らせて AIノートを生成する機能を日記タブに持たせる。
- **日次**: 日記詳細ヘッダに `📝 AIノートを書く` ボタン → `POST /api/ai/digest/run-now {date}` (選択中の日付)。
- **一括 (backfill)**: diary-bar の `📝 AIノート一括生成` ボタンでパネルを開閉。開始日/終了日 (既定 2026-04-01〜2026-06-30) + 「生成済みの日はスキップ」。`GET /api/ai/digest/candidates` で日記がある日を取得 → 古い順にクライアントが逐次 `run-now` を叩き、進捗バー + ログを表示 (停止可)。
- 生成物はすべて 🤖 AI タブ「AI記事」(と残りは記事ネタ) に溜まる。

## データ (server/db.ts に追加)

```sql
CREATE TABLE IF NOT EXISTS ai_articles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  body_md     TEXT NOT NULL,              -- 記事本文 (Markdown)
  topic_key   TEXT,                       -- 重複排除キー (repo:theme 等)
  source_refs TEXT,                       -- JSON 配列: [{kind, ref, repo}]
  origin      TEXT NOT NULL DEFAULT 'digest', -- 'digest' | 'requested'
  for_date    TEXT,                       -- 対象作業日 YYYY-MM-DD ("いつ書いたものか")
  tags        TEXT,                       -- JSON 配列: [{category, value}] (言語/プロジェクト/内容タイプ/技術領域/その他)
  note_id     INTEGER,                    -- 転写先 note.id (NULL=未転写)
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS ai_article_seeds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  summary     TEXT,                       -- なぜ記事になるか
  angle       TEXT,                       -- 提案アングル
  source_refs TEXT,                       -- JSON
  for_date    TEXT,
  status      TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'requested'|'done'|'dismissed'
  article_id  INTEGER,                    -- 記事化済みなら ai_articles.id
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS ai_advice (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  for_date     TEXT NOT NULL,             -- 生成対象日 YYYY-MM-DD
  body_md      TEXT NOT NULL,             -- 助言本文 (Markdown)
  data_summary TEXT,                      -- JSON: 投入データの件数等
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_articles_created ON ai_articles(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_seeds_status ON ai_article_seeds(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_advice_for_date ON ai_advice(for_date DESC);
```

> 既存 CREATE TABLE と同じ exec ブロックに置く (db boot 時の冪等作成)。CREATE INDEX は CREATE TABLE の後 ([[feedback_sqlite_create_index_after_alter]] に準拠)。

> **tags 列は後付け migration**: 既存 DB には ai_articles が既にあるため、`ALTER TABLE ai_articles ADD COLUMN tags TEXT` を PRAGMA table_info ガード付きで冪等発行し、その直後に `CREATE INDEX idx_ai_articles_for_date ON ai_articles(for_date DESC)` を発行する ([[feedback_sqlite_create_index_after_alter]]: INDEX は ALTER の後)。

#### タグの分類軸
`言語` / `プロジェクト` / `内容タイプ` / `技術領域` / `その他` の 5 分類 (`TAG_CATEGORIES`)。各記事に category ごと 0〜3 個。`日付 (for_date) × タグ` で AND フィルタできる。

タグ付けは **完成記事から専用の `article_tags` LLM (haiku) で抽出** する。当初は `article_write` の出力 JSON に tags を同梱させたが、長文の本文 (Markdown) と同じ JSON に tags を載せると末尾の tags が欠落・破損して `プロジェクト` (決定論) だけが残る不具合が出たため、短い出力だけを返す独立タスクに分離した。`プロジェクト` は source_refs のリポ名から決定論補完し、`article_tags` の結果とマージする。旧生成記事の救済に `POST /api/ai/articles/retag` (LLM 軸タグが欠けた記事を再タグ付け) を用意。

### app_settings キー
- `ai_digest.enabled` 既定 '1'
- `ai_digest.time` 既定 '06:00'
- `ai_digest.max_articles` 既定 '3'
- `ai_digest.last_date` (実行済みフラグ)
- `ai_advice.enabled` 既定 '1'
- `ai_advice.time` 既定 '06:00'
- `ai_advice.last_date`

### 物理ファイル参照
- session-log: `E:/Document/Ars/session-logs/YYYY-MM-DD.md` (補助材料、読めなければ無視)。読み取りは `server/ai-hub/session-log.ts` の `readSessionLog(dateStr)` に隔離 (パスは env `MEMORIA_SESSION_LOG_DIR` 上書き可、既定は上記)。

## API (server/routes/ai-hub.ts, mount `/api/ai`)

- `GET  /api/ai/articles?limit=50&from=&to=&tag=言語:TypeScript&tag=...` → `{ articles: AiArticle[] }` (for_date 範囲 + タグ AND 絞り込み。tag は `category:value` を繰り返し指定)
- `GET  /api/ai/tags` → `{ tags: ArticleTagCount[] }` (全記事のタグを category+value で集計、件数降順。フィルタ chips 用)
- `POST /api/ai/articles/retag` (body `{id?}`) → `{ updated, considered }` (id 指定で 1 件、無指定で LLM 軸タグが欠けた記事を一括再タグ付け)
- `POST /api/ai/articles/repair-bodies` → `{ repaired, considered }` (body_md に raw JSON が入った旧記事を内側 Markdown に修復、LLM 不要)
- `GET  /api/ai/digest/candidates?from=&to=` → `{ days: [{date, articleCount}] }` (範囲内で日記がある日 + 既存記事件数。一括生成 UI 用)
- `GET  /api/ai/articles/:id` → `{ article }` (404 if none)
- `POST /api/ai/articles/:id/transcribe` → 記事から note を作成し note_id を更新 → `{ note }`
- `GET  /api/ai/seeds?status=pending` → `{ seeds: AiSeed[] }`
- `POST /api/ai/seeds/:id/request` → seed を LLM で本記事化、ai_articles に insert、seed.status='done'+article_id 設定 → `{ article }`
- `POST /api/ai/seeds/:id/dismiss` → seed.status='dismissed' → `{ ok: true }`
- `GET  /api/ai/advice/latest` → `{ advice: AiAdvice | null }`
- `POST /api/ai/digest/run-now` → 記事ダイジェストを即時実行 (対象日は body.date or 昨日) → `{ articles, seeds }`
- `POST /api/ai/advice/run-now` → AIアドバイスを即時生成 → `{ advice }`

## LLM タスク (server/llm.ts に追加)

`LlmTaskName` / `TASKS` / `TASK_DEFAULT_MODELS` に追加:
- `article_topics` (既定 'sonnet') — 前日データから記事候補トピックを JSON で抽出・ランク付け
- `article_write` (既定 'claude-opus-4-7[1m]') — 1 トピックを本記事に。**プレーン Markdown** で出力させ (先頭行を `# タイトル` にし、本文に ```コードブロック``` 可)、先頭 H1 をタイトルとして分離する。文体は下記スタイル指示を prompt に同梱。
  - 当初は `{title, body_md}` の JSON で返させていたが、本文の ```コードブロック``` が JSON フェンス抽出を壊して raw JSON が body_md にそのまま入る不具合が出たため、プレーン Markdown 出力に変更した。旧記事の救済に `POST /api/ai/articles/repair-bodies` (raw JSON body を内側 Markdown に直す、LLM 不要)。
- `article_tags` (既定 'haiku') — 完成記事 (title + body) から 5 分類タグ (言語/プロジェクト/内容タイプ/技術領域/その他) を JSON 配列で抽出。短文・安価。`プロジェクト` は source_refs のリポ名で決定論補完してマージ
- `ai_advice` (既定 'sonnet') — 週次データから助言 (Markdown)

### 文体スタイル (article_write prompt に同梱する固定文字列)
> 読者は企業の現役エンジニア。専門用語は噛み砕かずそのまま使ってよい (初学者向けの過度な平易化はしない)。与えられた作業内容(source)の事実を実例の起点にし、設計判断の背景・トレードオフ・代替案・落とし穴まで踏み込んで技術的に深く解釈する (長くなってよい)。断定的でややトゲのある (挑発的な) 文体は残すが、初学者向けの砕けた口調 (「〜だぜ」「〜じゃね?」調) は使わない。AI は道具・判断は人間、という視点は保つ。タイトルはカッコ無しのパンチ重視。Markdown の見出し (#, ##)・箇条書き・必要なら ```コードブロック``` を使う。Notion 独自記法は使わない。誇張や捏造をせず、source の事実だけを基に書く。

> **読者層は意図的に 2 系統**: (A) Memoria の自動生成 AI記事 = 上記「企業の現役エンジニア」向け (本節)。(B) Notion の AIノート = バンタン受講生向けの口語・砕けた文体 ([[user_bantan_author_voice]])。A の記事を Notion AIノート (B) に載せるときは B の文体へ**翻訳**する ([[project_ai_note_opus_articles]])。

## 機能の置き場所 (server/ai-hub/)

```
server/ai-hub/
  types.ts           -- AiArticle / AiSeed / AiAdvice / TopicCandidate 型
  session-log.ts     -- readSessionLog(dateStr): string|null
  collect.ts         -- 前日 activity_events + session-log を 1 つのコンテキスト文字列に
  digest.ts          -- runDigest(db, dateStr): トピック抽出→上位N記事化→seed保存
  generator.ts       -- writeArticle(db, topic): article_write LLM 呼び出し1本
  advice.ts          -- runAdvice(db, dateStr): 週次データ収集→ai_advice LLM→保存
  scheduler.ts       -- startAiHubSchedulers(db): digest + advice の朝6時 tick
  index.ts           -- バレル
```

- DB アクセス関数 (insert/list/update) は `server/db.ts` に追加 (既存パターン踏襲、`insertAiArticle` / `listAiArticles` / `getAiArticle` / `setAiArticleNote` / `insertAiSeed` / `listAiSeeds` / `updateAiSeedStatus` / `insertAiAdvice` / `latestAiAdvice`)。
- 週次データ収集は既存の関数を再利用 (diary は `server/diary.ts`、rss digest は `server/rss/`、傾向/commits は recommendations-ai.ts の `recGitCommits` 等、tasks は `listTasks`)。domain 間 cross-import 禁止規約のため、収集は ai-hub/collect.ts と advice.ts に閉じ、必要な公開関数のみ import。

## スケジューラ起動
`server/lib/scheduler.ts` の `startSchedulers()` に `startAiHubSchedulers(deps.db)` を追加。実装は既存 `startGoalEvalScheduler` と同形 (毎分 tick、時刻一致 + `*.last_date` 当日ガード、try/catch で全体を止めない)。

## シェア可能か
local-only (derived)。記事/ネタ/助言は個人の作業ログから生成される派生物。Hub 共有しない。ノート転写後の公開はユーザの明示操作 (転写ボタン → note → 既存の共有フロー)。

## プライバシー観点
- 入力 (activity_events / session-log / 日記 / タスク) は個人データ。LLM 送信は既存 `runLlm` の provider 設定に従う (ローカル `gamma` 選択でローカル完結可)。
- session-log はリポジトリ外の作業記録なので、読み取り失敗時は静かに無視 (機能を止めない)。
- 生成物はローカル SQLite に閉じる ([[project_personal_data_rule]])。外部 API へ自動送信しない。
