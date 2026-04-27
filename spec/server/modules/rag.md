# Module: RAG (Semantic Search + Q&A)

保存済資産に対する意味検索と Q&A。

## 目的
キーワード一致では引っかからない関連記事を発見し、自分の蔵書を文脈にした質問応答を可能にする。

## 責務
- `chunks` テーブル (本文チャンク + 384 dim 埋め込み) の生成と維持
- `@huggingface/transformers` を lazy import してモデル `Xenova/multilingual-e5-small` を WASM 実行
- 検索: クエリ embed → 全 chunk と cosine → 上位を bookmark にグループして返却
- Q&A: 上位 K chunk を context にして claude CLI で回答生成

## ファイル

| ファイル | 役割 |
|---------|------|
| `service/embeddings.js` | model lazy load, `embed()`, `chunkText()`, `cosine()`, vec ⇄ Buffer 変換 |
| `service/index.js` | embeddingQueue + 検索/Q&A エンドポイント |

## チャンク戦略

- 段落単位 (`\n\n` で split) を 700 字目標、120 字 overlap
- 1 文書 max 30 chunk
- chunk[0] = `${title}\n\n${summary}` (ヘッダー)、それ以降は本文

## 埋め込み

- モデル: `Xenova/multilingual-e5-small` (multilingual e5、384 次元、q8 量子化)
- 初回 ~120MB を `~/.cache/huggingface/` にダウンロード
- `embed(text, kind)` の `kind` で `passage:` / `query:` プレフィックスを付与 (e5 慣例)

## ベクトル格納

- `chunks.vec` = Float32Array の生バイト (BLOB)
- 読み出し時は `bufferToVec(buf)` で `new Float32Array(new Uint8Array(buf).buffer)` (alignment 対策のためコピー)

## 検索 (`/api/search`)

```
qv = embed(query, 'query')
all = loadChunkCache()           // in-memory, 全 chunk
scored = all.map(c => cosine(qv, c.vec))
group_by(bookmark_id, max_score)
top K per bookmark
return [{bookmark_id, score, title, url, summary, chunk}]
```

## Q&A (`/api/ask`)

```
qv = embed(question, 'query')
top K chunks (1 per bookmark)
prompt = `Answer using only the sources, cite as [Source N]...
SOURCES:\n[Source 1: title (id, url)]\nchunk\n---\n[Source 2: ...]`
answer = claude -p prompt
return { answer, sources: [{id, bookmark_id, title, url, score}] }
```

## キュー

- `embeddingQueue` (FifoQueue) は summary キューと別レーン
- 要約完了時 (`enqueueSummary` の done 分岐) に自動で `enqueueEmbedding(id)` を呼ぶ
- 失敗時はチャンクを書き込まず終了 (再 backfill 可)

## 制限

- モデルは固定 (将来切替可能に)
- 全件 in-memory なので chunk 5000 (≈ 1000 ブックマーク) で ~7.5MB メモリ
- それ以上は brute-force cosine が遅くなるので sqlite-vec などへの移行検討
- バックフィル数百件で ~30〜60 分 (CPU bound)

## 環境変数

| 変数 | 用途 |
|------|------|
| `MEMORIA_RAG` | `0` で完全無効化 (検索/Q&A/embedding キューすべて停止) |
| `MEMORIA_RAG_AUTO_BACKFILL` | `1` で起動時に未インデックスを全部キュー投入 (既定 `0`) |

## ロードマップ

- sqlite-vec / sqlite-vss でハイブリッドインデックス (高速近傍検索)
- BGE-M3 等の上位モデルへ切替可能に
- ハイブリッド検索 (キーワード FTS5 + 意味)
- chunk のメタデータ (見出しレベル、URL fragment) 保存
