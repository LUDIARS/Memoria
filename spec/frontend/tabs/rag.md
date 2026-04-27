# タブ: RAG (Semantic Search + Q&A)

## 目的
保存済ブックマーク全体を埋め込みベクトル化し、意味検索と Q&A を提供する。
「どの保存記事が今の悩みに関連するか?」を素早く引き出す。

## 入力 API

| メソッド | パス | 用途 |
|---------|------|------|
| `GET` | `/api/rag/status` | enabled / model / 進捗 / chunk 数 |
| `POST` | `/api/rag/backfill` | 未インデックスを全部キュー投入 |
| `POST` | `/api/rag/reindex/:id` | 1 件再インデックス (要約再生成や手動編集後) |
| `GET` | `/api/search?q=&limit=` | top-K bookmark + 該当チャンク (cosine) |
| `POST` | `/api/ask` | `{q, k}` → claude が引用付き回答 |

## UI 要素

- ステータスバー
  - モデル名 (例: `multilingual-e5-small`)
  - インデックス進捗 `M/N ブックマーク (T チャンク)`
  - キュー深度 (バックフィル中)
  - 「未処理を全部キュー投入」ボタン (pending > 0 のとき表示)
- 検索バー
  - input + 「検索」「この質問で答える」(2 ボタン)
  - Enter で検索
- 回答カード (`/api/ask` の結果) — 検索より上に固定表示
  - `Answer` (Markdown 風 plain text、`[Source N]` 引用)
  - 引用ソース: タイトル + URL リンク
- 結果リスト (`/api/search` の結果)
  - 各行: タイトル / URL / chunk 抜粋 (5 行クリップ) / コサイン類似度 (% 表示)
  - 行クリックで bookmarks タブに切替 + その bookmark の詳細パネル

## ロジック

- chunk_cache はサーバー in-memory (一度ロードすれば 5000 chunk × 384 dim ≒ 7.5MB)
- 検索: 入力を embed → cosine 全件比較 → bookmark id でグルーピング → top K
- Q&A: 上位 K チャンクをコンテキストに claude 起動、`Answer` 全文返却

## 制限

- 初回利用で HuggingFace モデル ~120MB ダウンロード
- バックフィルは数百件で 30〜60 分 (CPU bound)
- `MEMORIA_RAG=0` で完全無効化

## ロードマップ

- 検索結果を Q&A の引用元として可視化 (リッチな引用 UI)
- ユーザーモデル切替 (e5-large, BGE-M3 等)
- ハイブリッド検索 (キーワード + 意味の合成スコア)
