# Tendentia との接続

## 目的

トレンドの巡回・集積・トレンドマップは 2026-10-14 に独立サービス Tendentia (Td、LUDIARS/Tendentia) へ移した。
Memoria は 🤖 AI タブの「📈 トレンド」で、Tendentia が選んだジャンルごとの注目 (新登場・急上昇・複数サイト) と
複数のサイトで話題のものだけを表示し、詳しく見るときは「Tendentia で開く」から Tendentia の画面へ移る。

## 構成

- `server/tendentia-link/router.ts`: `GET /api/tendentia/summary` (同一端末のみ)。Tendentia の
  `GET /api/trend-crawler/overview` を Memoria のサーバから読み、要点と開く URL を返す。
  - 接続先: Excubitor が配る `TENDENTIA_URL` (Tendentia の catalog の provides)。
  - 開く URL: `TENDENTIA_PUBLIC_URL` があればそれ (外から開ける公開 URL)、無ければ `TENDENTIA_URL`。
  - 応答: `{ available: true, openUrl, summary }` / `{ available: false, openUrl, reason }`。
- `server/tendentia-link/summary.ts`: Tendentia の一覧から要点 (注目のあるジャンル・複数サイト話題 8 件まで) を写す純関数。
- `server/public/src/tendentia-view.ts`: 表示。

## 制約

- トレンドのデータは Memoria に保存しない (正本は Tendentia の `data/tendentia.db`)。
- Tendentia の応答は外部サービス由来として扱い、文字列の長さと URL (http/https のみ) を確かめてから写す。
- Tendentia が止まっている・接続先が無いときは理由を表示し、Memoria の他の機能には影響させない (10 秒で打ち切る)。
- Memoria 側に残っている旧表 (`trend_snapshots` / `trend_items` / `trend_clicks`) は触らない。
