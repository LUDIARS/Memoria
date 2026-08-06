# クレバーサーチ

## 概要

Memoria に蓄積した個人ログを単語で横断検索し、カテゴリ別の固定フォーマットへ
統合する local-only 機能。検索とレポート生成は SQLite FTS5 と固定テンプレートで
完結し、外部 LLM やサブスクリプション API を使わない。

## ユースケース

- 数か月分の開発・会話・知識・振り返り・タスクから、関連記録を5秒以内に探す。
- 最大5件のランダム代表引用で概要をつかみ、必要なときだけ全引用を展開する。
- 同じ検索語の保存済みレポートを再表示し、新しいログが必要な場合だけ再作成する。

## 画面 / 入口

ローカル UI の「🔭 クレバーサーチ」タブから検索語を入力する。結果には全体要約、
総件数、対象期間、月別タイムライン、カテゴリ別内訳、代表引用、折りたたまれた全引用を
表示する。全引用の DOM は初回展開時に生成し、大量一致時の初期描画を抑える。

## データ

- `clever_search_sources`: 既存テーブルを検索用の共通文書へ投影する再生成可能な索引。
- `clever_search_fts`: `title` と `content` を検索する FTS5 external-content table。
- `clever_search_reports`: 検索語、集計値、全引用を含む version 付きレポート履歴。

対象とカテゴリの対応は次のとおり。

| レポートカテゴリ | 対象 |
|---|---|
| 開発・活動ログ | `activity_events` |
| 会話ログ | `external_chat_messages` |
| 知識・調査 | bookmarks / dig / dictionary / notes |
| 日記・振り返り | diary / weekly reports |
| タスク・改善記録 | tasks / implementation notes |

元テーブルの insert / update / delete trigger で投影を同期する。作成済みレポートは
不変の履歴として残し、`refresh=true` の再作成でも旧レポートを削除しない。

## API

- `POST /api/clever-search`: 検索または最新キャッシュの取得。
- `GET /api/clever-search/reports`: 保存済みレポートのメタデータ一覧。
- `GET /api/clever-search/reports/:id`: 保存済みレポート本体の取得。

すべて direct loopback 専用で、cross-origin request を拒否し、
`Cache-Control: no-store` を返す。検索文字列は正規化後1〜120文字、履歴の `limit` は
省略時20、指定時は1〜100の10進整数だけを受理する。

## シェア可能か

🏠 **local-only**。Hub / Corpus / Multi share の経路を持たず、検索結果や保存済み
レポートを共有 DB、外部 API、外部 LLM へ送らない。

## プライバシー観点

索引とレポートには会話、日記、活動 metadata、タスクなど機微な個人ログが含まれる。
LAN や tunnel 経由のアクセス、外部 origin からの localhost 呼び出しを API 境界で
拒否する。履歴一覧は引用本文を返さないが、検索語自体も個人情報になり得るため、
レポート本体と同じ direct-loopback 制約を適用する。削除 API はなく、元データ削除後も
既存レポートは履歴として残るため、DB ファイルの保持・削除ポリシーに従う。

## 検索・レポート方式

SQLite FTS5 の trigram tokenizer で日本語を含む3文字以上の部分一致を行う。1〜2文字を
含む検索は FTS5 が索引できないため、エスケープした parameter binding の `LIKE` に
切り替える。代表引用だけを reservoir sampling で抽出し、一致した引用自体は削らない。

## 非機能要件と検証

- 10,000件が同一語に一致するインメモリ SQLite の回帰条件で、FTS と1〜2文字の
  `LIKE` fallback のどちらも5秒未満。
- router test でカテゴリ集計、全引用保持、キャッシュ、再作成を確認する。
- router test で元レコードと bookmark category / note block の変更、親削除時の cascade が
  FTS 投影へ同期することを確認する。
- router test で remote address、cross-origin、履歴 `limit` の境界を確認する。
- 画面のタブ遷移、検索、履歴再表示、折りたたみ遅延描画はブラウザ実行確認の対象とする。

## ローカル LLM について

Qwen / Gemma 等による文章の再要約は将来の任意拡張とする。現行版は固定テンプレートと
集計のみでレポートを生成するため、モデルの導入・起動待ち・GPU要件はない。
