# タブ: 傾向 (Trends)

## 目的
保存・閲覧傾向のサマリを期間切替で可視化。自分が今どんな分野を掘っているのか、何が消えたのかを 1 画面で把握する。

## 入力 API

| メソッド | パス | 用途 |
|---------|------|------|
| `GET` | `/api/trends/timeline?days=N` | 日次の保存数 + アクセス数 |
| `GET` | `/api/trends/categories?days=N` | カテゴリ別保存数トップ 12 |
| `GET` | `/api/trends/category-diff?days=7` | 直近 N 日 vs 前 N 日の増減トップ 8 |
| `GET` | `/api/trends/domains?days=N` | アクセス回数トップドメイン 12 |

## UI 要素

- ヘッダー: 期間 select (`過去 7 / 30 / 90 / 365 日`)
- 4 カード (CSS Grid `auto-fill minmax(420px, 1fr)`)
  1. **保存とアクセスの推移** — 折れ線 2 本 (青: 保存, 橙: アクセス)、X 軸日付ラベル
  2. **カテゴリ別 保存数** — 水平棒グラフ (青)
  3. **増えた・減ったカテゴリ (7 日比較)** — `current → previous` + delta (+/− で色分け)
  4. **よく訪れているドメイン** — 水平棒グラフ (橙)

## チャート実装

- 依存追加なし、SVG 直接描画 (`svgHorizontalBar`, `renderTrendTimeline` in `app.js`)
- `viewBox` で幅可変、`preserveAspectRatio="xMinYMin meet"`
- Y 軸ラベルは 0 / max/2 / max のみ、X 軸はデータ点数に応じて間引き

## 制限

- グラフは静的 SVG (interactive tooltip なし)
- カテゴリ・ドメインの top N は固定
- データが 0 件の期間は「データなし」を表示

## ロードマップ

- カードのドリルダウン (棒クリックでブックマーク一覧タブにジャンプ + フィルタ)
- 期間カスタム指定 (date picker)
- 推薦タブとの統合 (傾向データから自動推薦の根拠提示)
