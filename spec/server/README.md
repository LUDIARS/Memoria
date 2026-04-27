# Memoria — Backend (service/) 仕様

`service/` 配下のサーバー実装をモジュールごとに記述。

## 構成

| パス | 内容 |
|------|------|
| [`overview.md`](overview.md) | プロセス全体構造、起動シーケンス、依存マップ |
| [`api.md`](api.md) | 全 HTTP API の一覧 (リクエスト/レスポンス形式) |
| [`database.md`](database.md) | SQLite スキーマ、マイグレーション、user_id スコープ |
| [`modules/bookmark.md`](modules/bookmark.md) | ブックマーク CRUD + 重複ハンドリング |
| [`modules/summary-queue.md`](modules/summary-queue.md) | claude CLI 直列キュー |
| [`modules/visits.md`](modules/visits.md) | 訪問履歴 + 保存漏れスコア |
| [`modules/recommendations.md`](modules/recommendations.md) | 外部リンク推薦エンジン |
| [`modules/rag.md`](modules/rag.md) | 埋め込み生成 + 意味検索 + Q&A |
| [`modules/dig.md`](modules/dig.md) | Deep Research (claude WebSearch) |
| [`modules/content-filter.md`](modules/content-filter.md) | NG/R18 ワード遮断 |
| [`modules/auth.md`](modules/auth.md) | local / online 切替、JWT 検証、admission revoke |
| [`modules/cernere-bridge.md`](modules/cernere-bridge.md) | service-adapter 統合 (admission + peer + events) |

## 共通方針

- **依存追加に保守的**: 新規 npm パッケージは「他に妥当な代替がない」場合のみ。`@huggingface/transformers` 等の重量級は明確な利益と引き換えに導入する。
- **疎結合**: モジュール間は関数 import か `index.js` での組み立てで繋ぐ (event bus は導入しない)。
- **個人データ**: `bookmarks.user_id` 以外の personal data はサーバー DB に持たない。Cernere を単一情報源とする LUDIARS ルールに従う。
- **fail-soft**: Cernere 連携や RAG モデルが落ちてもメインの保存・要約フローは止めない。
