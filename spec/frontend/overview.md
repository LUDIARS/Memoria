# Frontend Overview

## 目的
保存したブックマーク / 訪問履歴 / 推薦 / 検索 / Q&A を単一ページで操作する。

## 責務
- バックエンド `/api/*` を叩いて表示・編集・トリガーする。
- 動作モード (`local` / `online`) を判定し、ローカル限定機能を出し分ける。
- 要約キューとイベント駆動更新で「保存中」「要約済」を即時に反映する。

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `service/public/index.html` | 単一 HTML、各タブの DOM スケルトン |
| `service/public/app.js` | 全 UI ロジック (state + render + 各タブ controller) |
| `service/public/style.css` | デザイントークン + コンポーネント CSS |

## グローバル state (app.js)

```js
state = {
  bookmarks: BookmarkRow[],
  categories: { category, count }[],
  category: string | null,           // サイドバーの絞り込み
  selected: Set<id>,                  // bookmarks タブの複数選択
  detailId: number | null,            // 右ペイン
  search: string,
  sort: 'created_desc' | ...,
  tab: 'bookmarks' | 'queue' | 'visits' | 'trends' | 'recommend' | 'rag' | 'dig',
  queue: { items, history },
  visits, visitsSelected, visitsRange,
  trendsRange,
  recommendations,
  ragStatus, ragResults, ragAnswer,
  digSession, digHistory, digSelected, digPolling,
  mode: 'local' | 'online',
}
```

## ヘッダー

- 左: ブランド `Memoria` + (online モード時) `online` ピル
- 中央: 「要約待ち N」バッジ (キュー深度 > 0 のとき脈動表示)
- 右: ソート select、検索 input、Export ボタン、Import ファイル選択

## サイドバー

- 「すべて」+ カテゴリ別件数
- 選択でメイン領域のカード一覧を絞り込む

## 認証 (online モード)

Bearer JWT を `Authorization` ヘッダーで送る (Chrome 拡張の options 画面で設定)。
Web UI が直接ブラウザから操作する想定では JWT を localStorage 等に保持する経路は **未実装** — オンライン運用時は MCP / 拡張からの利用が前提。

## ポーリング

- 2 秒ごとに `/api/queue` を叩いてヘッダーバッジを更新
- キュー深度 > 0 もしくは `pending` ブックマークがある場合に `load()` を再実行
- `queue` タブを開いている時は実行中ジョブの経過秒もリアルタイム更新

## ロードマップ

- WebSocket でキュー更新を push 受信 (現在ポーリング)
- ダークモード切替
- アクセシビリティ強化 (キーボードナビゲーション、ARIA)
