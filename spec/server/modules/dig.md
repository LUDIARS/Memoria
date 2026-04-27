# Module: Dig (Deep Research)

claude CLI を Web 検索 + フェッチツール許可で起動して、特定トピックを「掘る」。

## 目的
保存済資産の RAG とは別に、**Web 全体** を対象にしたソース収集を提供する。気になるソースを選べばそのまま Memoria に保存できる。

## 責務
- `dig_sessions` テーブルでセッション履歴管理
- `digQueue` (FifoQueue) で claude CLI を直列実行
- claude プロンプトで JSON 厳格出力を要求し、`{query, summary, sources[]}` を抽出
- セッション完了時に `memoria.dig.completed` を peer に発火

## ファイル

| ファイル | 役割 |
|---------|------|
| `service/dig.js` | プロンプト + spawn + JSON parse |
| `service/index.js` | digQueue + REST endpoints + peer handler |

## プロンプト

```
You are a research agent. Use Web search and fetching to gather authoritative sources for the topic the user provides.

Return STRICTLY one JSON object and nothing else:
{
  "query": "<original>",
  "summary": "1〜3 段落で領域を概観 (日本語)",
  "sources": [
    { "url": "...", "title": "...", "snippet": "1〜2 文", "topics": ["k1", "k2"] }
  ]
}

- 8〜12 件
- ドメイン/視点が偏らないよう多様性
- topics は 2〜4 個
- 重複 URL や広告ページは除外

QUERY: <user input>
```

## 起動コマンド

```
claude -p "<prompt>" --allowedTools WebSearch,WebFetch
```

タイムアウト 600 秒 (deep research は長め)。

## API

| Path | 説明 |
|------|------|
| `POST /api/dig` | `{query}` → セッション作成、id 返却 (status=pending) |
| `GET /api/dig` | 履歴 30 件 |
| `GET /api/dig/:id` | 詳細 (`{query, status, result}`) |
| `POST /api/dig/:id/save` | `{urls[]}` を bulkSaveUrls で保存 |

Peer handler `memoria.dig` も同じ enqueueDig 経由。

## 制限

- claude CLI が WebSearch/WebFetch tool を許可されていないと `result_json` が空 / エラー
- 1 セッション 5〜10 分
- JSON 解析失敗で `status='error'`

## ロードマップ

- 進捗 (claude のツール実行ごとの Trace) を取って UI にリアルタイム表示
- 結果のソース URL 同士の関連度を計算してグラフを force-directed に
- セッション横断のトピッククラスタ抽出 (傾向タブ統合)
