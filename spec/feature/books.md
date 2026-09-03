# 本棚 (良かった本 / 新刊チェック / 人気サジェスト)

## 目的

読んで良かった本を残しておくと、

1. その著者・シリーズの**新刊が出たら知らせる** (週 1 巡回 → Discord `#announce`)
2. 傾向から**次に読む 1 冊を提案する** (AI 推薦 + 楽天売れ筋 + Google Books 高評価)

の 2 つが自動で回る。蔵書リスト自体も 📚 本タブと Discord から編集できる。

評価 (お気に入り) は本人が手で付けるものとし、自動では付けない。読破記録だけは
Amazon の「データのリクエスト」で書き出した履歴を年 1 で取り込む。

## 構成

- `server/books/types.ts`: 蔵書 / 候補 / 新刊 / サジェスト / 設定の型。
- `server/books/schema.ts`: `books` / `book_new_releases` / `book_suggestions` / `book_suggestion_blocks`。
- `server/books/bib.ts`: ISBN 正規化、タイトルキー、著者・日付・シリーズの正規化。**所持判定と重複排除は必ず `titleKey` で行う。**
- `server/books/config.ts`: zod スキーマ、既定値、`app_settings` への設定と取り込み状態の保存。楽天アプリ ID のマスク往復。
- `server/books/store.ts`: DAO。SQL はここだけに置く。
- `server/books/sources/`: `google-books.ts` / `openbd.ts` / `ndl.ts` / `rakuten.ts` / `http.ts` (SSRF ガード付き取得)。
- `server/books/lookup.ts`: 登録フォーム用の書誌検索。Google Books → (失敗時) NDL のフォールバックと警告文の組み立て。
- `server/books/watch.ts`: 良かった本から著者・シリーズのウォッチ対象を導出 (永続化しない)。
- `server/books/new-release.ts`: ソース横断で候補を集め、発売日・所持・著者一致で新刊に絞る。
- `server/books/suggest-prompt.ts` / `suggest.ts`: LLM 推薦のプロンプトとパース / 3 系統のマージとスコアリング。
- `server/books/import-parse.ts` / `import.ts`: 読破記録ファイルのパース / books への取り込みと年次催促。
- `server/books/scheduler.ts`: 週次巡回 (新刊 → サジェスト再生成)。
- `server/books/router.ts`: 同一端末限定の HTTP API。
- `server/discord/book-commands.ts` / `discord/actions/book.ts` / `discord/notify/books.ts`: Discord 操作と新刊通知。
- `server/public/src/books-view.ts`: 📚 本タブ。

## 書誌ソース

| ソース | キー | 役割 |
|---|---|---|
| NDL サーチ (OpenSearch) | 不要 | 和書の新刊網羅。著者・タイトル + `from` で巡回する主軸。**`mediatype` は文字列 `books`** — 旧 API の数値 (`1`) を送るとエラーにならず `totalResults=0` が返るだけで、取りこぼしに気づけない |
| Google Books | 不要 | 洋書と著者検索、**平均評価** (`averageRating` / `ratingsCount`) の唯一の取得元 |
| openBD | 不要 | ISBN 引き専用。書影・出版社・発売日の肉付け |
| 楽天ブックス | applicationId | **売れ筋順** (`sort=sales`) の唯一の取得元。ID 未設定なら自動的に無効 |

## 新刊チェック

- ウォッチ対象は保存しない。`rating >= watchMinRating` (既定 ★4) の本から著者・シリーズを毎回導出する。評価を下げれば対象から外れる。
- 発売日が `[今日 - lookback, 今日 + lookahead]` (既定 60 日前〜120 日後) の候補だけを新刊とする。**発売日が取れない候補は捨てる** (判定できないため)。
- `(watch_kind, watch_value, title_key)` に UNIQUE を張ってあるので、何度巡回しても同じ本の通知は 1 回きり。
- 通知は `notified_at` が null の行を Discord スケジューラが拾い、Discord ぎわで送信成功を確認した後だけ通知済みにする。Discord が落ちていた週の分も復帰後に届く。
- 有効な書誌ソースの取得失敗は結果の `errors` に残し、週次ジョブを完了扱いにせず 6 時間後に再試行する。

## サジェスト

3 系統をマージし、`origin` の重み + 品質加点 (評価または売れ筋順位) でスコア付けする。

| origin | 出所 | 重み |
|---|---|---|
| `llm` | 良かった本の傾向 → LLM (`book_suggest`) → **書誌 API で実在確認** | 1.0 |
| `rakuten_ranking` | 好きな著者・タグの楽天売れ筋 | 0.8 |
| `google_rating` | 好きな著者の Google Books 高評価作 (★4.0 以上・10 件以上) | 0.6 |

- LLM が挙げた本は書誌 API で照合できたものだけ採用する (架空タイトル除け)。
- 「興味なし」は `book_suggestion_blocks` に `title_key` を積み、以後の生成から恒久的に外す。
- 生成のたびに未 dismiss の候補を総入れ替えする。ただし取得失敗で新しい候補が 0 件になった場合は、一時障害で表示を空にしないよう前回の候補を保持する。

## 読破記録の取り込み

Kindle の読破記録には公式 API が無い (Amazon PA-API は商品情報のみ、Goodreads API は 2020 に新規発行停止)。
そのため **Amazon の「データのリクエスト」で書き出した履歴を年 1 で取り込む**運用とする。

- 受け付ける形式: CSV (Amazon データリクエスト / ブクログ / 読書メーター、英語・日本語ヘッダ両対応) と Kindle 端末の `My Clippings.txt`。
- 列名は別名表で部分一致検出する (書き出しごとに列名が変わるため)。
- `read_on` には「読了日」「completion date」など明示的な完了列だけを入れ、購入日・登録日・My Clippings のハイライト日時は読了とみなさない。**既存の `rating` / `review` は絶対に触らない。**
- 前回取り込みから 365 日経つと Discord に 1 回だけ催促を出す。

## 書誌検索 (登録フォーム)

Google Books はキー無しで使える代わりに共有 IP の quota に当たりやすく `429` を返す。
1 ソースの失敗で登録経路を止めないため、`/api/books/lookup` は次の順で降りる。

1. Google Books → 0 件または失敗なら、タイトルと著者を別パラメータにして NDL サーチ
2. 取れた候補を openBD で肉付け (失敗したら素の候補を返す)
3. 全滅しても `candidates: []` + `warning` を返す (500 にしない)

画面は warning を登録完了メッセージに添えるだけで、手入力の登録自体は通す。
warning には失敗したソース名だけを含め、外部応答本文・URL・例外詳細はブラウザへ返さない。

## 著者名の正規化

NDL は典拠形 (`かわぐち, かいじ, 1948-`) で著者を返す。生没年とカンマを落として
`かわぐち かいじ` に直さないと、著者ウォッチの名前一致が外れて**新刊を丸ごと取りこぼす**。
`cleanAuthor` で生没年除去 → `姓, 名` の結合まで行う。

## Discord

| コマンド | 動作 |
|---|---|
| `/book <title> [author] [rating] [memo]` | 良かった本を登録 (書誌 API で著者・書影・ISBN を補完) |
| `/books [query]` | 本棚を見る (引数なし = お気に入り) |
| `/book-new` | 新刊チェックを今すぐ実行 |
| `/book-suggest [refresh]` | サジェストを見る / 生成し直す |

新刊通知は `#announce` に投稿する。コマンドはすべて self ユーザ限定。

## 制約

- HTTP API は `isSameMachineRequest` で同一端末に限定する (local-only 機能)。
- 外部取得はすべて `shared/public-fetch.ts` 経由 (SSRF ガード + サイズ上限)。
- 手動実行と週次巡回は `BooksJobCoordinator` で直列化し、外部 API を二重に叩かない。
- 楽天アプリ ID は `app_settings` の設定 1 系統に置く (env からは読まない)。画面へはマスクして返し、空文字の PUT は「変更なし」と解釈する。

## シェア可能か

🏠 **local-only**。Hub への共有経路は持たず、蔵書・感想・読了履歴・楽天アプリ ID はローカル SQLite にのみ保存する。

## プライバシー観点

- 登録時の書誌補完では、入力したタイトル・著者を有効な Google Books へ送り、0 件または失敗時は NDL サーチへ送る。
- 読書サジェスト生成時は、本のタイトル・著者・評価・タグと感想の先頭 80 文字を設定済み LLM へ送る。実在確認用の Google Books / NDL を両方無効にした場合は LLM を呼び出さない。
- ブラウザ API は同一端末 + same-origin に限定し、Discord コマンドは self user 限定かつ ephemeral で返す。新刊の自動通知だけは設定済み `#announce` へ投稿する。
- 楽天アプリ ID は GET とログに原文を出さず、Discord 投稿では外部書誌内の任意メンションを展開しない。
