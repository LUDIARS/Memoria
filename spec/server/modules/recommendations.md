# Module: Recommendations

保存済 HTML から外部リンクを抽出して未訪問サイトを推薦するエンジン。

## 目的
ユーザーが「次に読むべき」関連サイトを発見しやすくする。新規 Web 検索ではなく、**自分が既に保存した記事の引用先** を信頼できるソースとして推薦に使う。

## 責務
- `bookmarks` 直近 250 件の HTML を `data/html/` から読み、`<a href>` を全件抽出
- 既存 (`bookmarks` / `page_visits`) URL と `recommendation_dismissals` を除外
- 出現件数 + ソース記事数でスコアリング
- 結果を 30 分メモリキャッシュ
- dismiss されたら以降の候補から永久除外

## ファイル

`service/recommendations.js` 一本。

## ロジック

```
sources = direct 250 bookmarks (created_desc)
saved_urls   = ALL bookmarks.url
visited_urls = ALL page_visits.url
dismissed    = ALL recommendation_dismissals.url

for each source:
  read HTML, parse, find <a href>
  for each anchor:
    abs = resolve(href, source.url) を strip-fragment + strip-tracking-query
    skip if same domain as source
    skip if abs in saved/visited/dismissed
    skip if seen in this doc
    record link → bookmark_ids, anchor text, count

score = source_count * priority + count
filter: source_count >= 2 OR count >= 3
sort:   source_count DESC, count DESC
top 100
```

## 制限

- per-doc 80 リンク cap (ナビゲーションページ対策)
- `same domain` は host suffix 一致 (`docs.example.com` ⊆ `example.com`)
- 30 分キャッシュ。`force=1` で再計算
- dismiss 状態が変わったらキャッシュも invalidate

## トラッキング除去

URL 正規化時に以下のクエリパラメータを剥がす:
- `utm_*`, `fbclid`, `gclid`, `ref`, `source` (case-insensitive)

## ロードマップ

- claude にカテゴリ群を渡してトピック推薦も追加 (現在は引用ベースのみ)
- 推薦理由の詳細パネル (どの保存記事のどのリンクテキストか)
- スコアの time decay (古い保存記事の影響を弱める)
