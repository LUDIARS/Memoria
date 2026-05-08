# wordcloud — ワードクラウド (キーワード抽出 + グラフ)

## 概要
Bookmark / Dig / 単一ブクマ本文 / 複数 cloud の merge から、 LLM でキーワード ○ 抽象用語 / □ 具体名詞を抽出してクラウドを作る。 子クラウドにドリルダウンできるツリー構造を持つ (`parent_cloud_id`)。

## ユースケース
- カテゴリ別ブクマ群 / 1 件のブクマ / dig セッションの **要点語** を一覧
- 「この語をさらに掘る」 で派生 cloud を生成しドリルダウン
- 複数 cloud をマージして共通項を炙り出す (`/api/wordcloud/merge`)
- 抽出語を辞書に登録 (`/api/dictionary/upsert-from-source` source_kind='cloud')

## 画面 / 入口
- ブクマ一覧 → カテゴリ単位 wordcloud ボタン
- ブクマ詳細 → 「このページの wordcloud」 (`/api/bookmarks/:id/wordcloud`)
- dig セッション詳細 → 「sources からクラウド」
- ワードクラウド一覧 → グラフ表示 (`/api/wordcloud/:id/graph`)

## データ
- [word_clouds](../db/wordcloud.md) — origin (bookmark / bookmarks / dig / merged) / parent_cloud_id / parent_word / result_json / origin_bookmark_id (CASCADE) / origin_dig_id

## API
- [dict.md](../api/dict.md) — `/api/wordcloud*`、 `/api/wordcloud/:id/graph` (BFS で半径 1-3)、 `/api/wordcloud/:id/siblings`、 `/api/wordcloud/merge`、 `/api/wordcloud/validate-word`
- ストップワード: `/api/stopwords*`

## シェア可能か
**local-only**

ワードクラウドそのものを Hub にシェアする経路は無い (`/api/multi/share` の kind 列挙に無し)。 派生ソースの bookmark / dig をシェアすれば、 Hub のダウンロード側で各自再生成する形。

## プライバシー観点
- **個人データを保持するテーブル**: `word_clouds.result_json` には抽出語と元 sources の URL / title / snippet が含まれる (related_pages 経由で表示)。 origin が bookmark の場合は **対象ブクマの本文要約 + URL** が間接的に紐付く。
- **LLM プロバイダに送る情報**: タスク `cloud_extract` でブクマ群の `[Doc N] title / URL / categories / summary` (各 800 字) を、 単一ブクマでは本文テキスト 12,000 字を Claude / Gemini / Codex / OpenAI に送る。 dig 由来は overview + sources の URL/title/snippet。 `cloud_validate` (`/api/wordcloud/validate-word`) は語 + コンテキストを送る。 すべてユーザの API key スコープ。
- **共有時に外部に出ない情報**: クラウド全部 (シェア対象外)。
- **削除時の挙動**: 元の bookmark を削除すると CASCADE で `origin_bookmark_id` 経由のクラウドも消える。 dig セッション削除時は origin_dig_id が orphan 化 (UI ハンドル)。 ストップワード除外は再生成しないと反映されない。
