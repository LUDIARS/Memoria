# Memoria — Frontend 仕様

Web UI (`service/public/`) と Chrome 拡張 (`extension/`) の仕様をまとめる。

## 構成

| パス | 内容 |
|------|------|
| [`overview.md`](overview.md) | UI 全体構造、タブ切替、認証、状態管理 |
| [`extension.md`](extension.md) | Chrome 拡張 (MV3) の仕様 — popup, content script, background |
| [`tabs/bookmarks.md`](tabs/bookmarks.md) | 「ブックマーク」タブ |
| [`tabs/queue.md`](tabs/queue.md) | 「要約キュー」タブ |
| [`tabs/visits.md`](tabs/visits.md) | 「未保存履歴」タブ (ローカルモード限定) |
| [`tabs/trends.md`](tabs/trends.md) | 「傾向」ダッシュボード |
| [`tabs/recommend.md`](tabs/recommend.md) | 「おすすめ」タブ |
| [`tabs/rag.md`](tabs/rag.md) | 「RAG」(意味検索 + Q&A) タブ |
| [`tabs/dig.md`](tabs/dig.md) | 「ディグる」(Deep Research) タブ |

## 共通方針

- **ライブラリ依存ゼロ**: vanilla JS + 自前 SVG。React 等は導入しない。
- **CSS Variables** ベースのテーマ。`service/public/style.css` で一元管理。
- **モバイル**: 基本対応するが、最初の MVP は PC ブラウザ前提。
- **アクセシビリティ**: タブ切替は `role="tab"` + キーボード移動を将来対応。
- **モード分岐**: 起動直後に `/api/mode` を呼び、`online` ならば「未保存履歴」タブを非表示にしてヘッダーに `online` ピル表示。
