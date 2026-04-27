# タブ: おすすめ (Recommend)

## 目的
保存済 HTML から外部リンクを抽出 → 未訪問のサイトを「推薦」する。
スコアは「同じリンクが何件の保存記事に出現したか」をベース。

## 入力 API

| メソッド | パス | 用途 |
|---------|------|------|
| `GET` | `/api/recommendations` | 推薦リスト (キャッシュあり、30 分 TTL) |
| `GET` | `/api/recommendations?force=1` | キャッシュ無視で再計算 |
| `POST` | `/api/recommendations/dismiss` | `{url}` を以降の候補から除外 |
| `DELETE` | `/api/recommendations/dismissals` | dismiss リストを全削除 |
| `POST` | `/api/visits/bookmark` | 「保存」ボタン共通の bulk save API |

## UI 要素

- ヘッダー: 説明文 + 「再計算」ボタン
- カード (CSS Grid `minmax(360px, 1fr)`)
  - ドメイン (アクセントカラー) + score バッジ「N 件の記事から」
  - アンカーテキスト (太字、クリッカブル風)
  - URL
  - 参照元: 出現していた保存記事タイトル (最大 3 件)
  - アクション: 「保存」 / 「開く」 / 「却下」

## ロジック

- 「保存」 → `/api/visits/bookmark` で fetch + 要約キュー投入 → カードを消す
- 「却下」 → `/api/recommendations/dismiss` でサーバーキャッシュも invalidate
- 「再計算」 → `force=1` で 250 件のソース HTML を走査し直す (~数秒)

## 制限

- ソース HTML は直近 250 ブックマークのみ走査
- スコアは `source_count >= 2 || count >= 3` のフィルタ後 top 100
- トラッキング系 query (utm_*, fbclid 等) は URL 正規化時に剥がす

## ロードマップ

- claude にカテゴリ群を渡してトピック推薦も追加
- 「却下」をワンクリックで取り消すリンクを保存 (3 秒間 toast)
- 推薦根拠の詳細パネル (どの保存記事のどのリンクテキストか)
