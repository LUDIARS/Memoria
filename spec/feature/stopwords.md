# stopwords — wordcloud 除外語

## 概要
ワードクラウド / 傾向タブの集計から除外したい単語のユーザ定義リスト。 lowercased で `user_stopwords` に保存。

## ユースケース
- ワードクラウドに毎回出てくる固有名詞 (自分の社名 / プロジェクト名等) を抑制
- 傾向タブの上位語表示でノイズを消す
- 1 度追加すれば全 wordcloud / trends で再生成時に効く

## 画面 / 入口
- ワードクラウド画面の語ノード右クリック / 設定パネル → `+` で追加
- 設定タブの `ストップワード` 一覧で削除

## データ
- [user_stopwords](../db/stopwords.md) — word (PK, lowercased) / added_at
- 注意: ドメインカタログ自動分類 (`classifyDomain`) のキーワード抽出には適用されない (汎用ストップワードと別運用)

## API
- [dict.md](../api/dict.md) — `GET /api/stopwords` / `POST /api/stopwords` `{ word }` / `DELETE /api/stopwords/:word`

## シェア可能か
**local-only**

ストップワード = 個人の関心 / 文脈を表すノイズリスト。 シェア対象外。

## プライバシー観点
- **個人データを保持するテーブル**: `user_stopwords` (除外したい語、 関心の裏返し)。 機微度は低め。
- **LLM プロバイダに送る情報**: 直接送らない。 wordcloud 生成時に prompt に「除外せよ」 指示として渡る場合がある (実装は wordcloud.ts 側、 算出後フィルタ + LLM 指示の両方を併用)。
- **共有時に外部に出ない情報**: 全部。
- **削除時の挙動**: `DELETE /api/stopwords/:word` で行を抹消。 既存 wordcloud は再生成しないと再フィルタされない。
