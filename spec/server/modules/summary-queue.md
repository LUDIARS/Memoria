# Module: Summary Queue

claude CLI を直列実行する要約パイプライン。

## 目的
ローカルの `claude -p` を起動して JSON で要約 + 3〜5 カテゴリを取得。並列実行は API キー消費とリソース競合の理由で禁止。

## 責務
- FifoQueue (Promise チェーン) でジョブを直列化
- `bookmarks.status='pending'` の起動時復旧
- 進捗を `setSummary` で永続化、UI のヘッダーバッジに反映
- 成功時に `enqueueEmbedding` (RAG) と `emitEvent(summary.done)` を発火

## ファイル

| ファイル | 役割 |
|---------|------|
| `service/queue.js` | `FifoQueue` 実装 (汎用) |
| `service/claude.js` | HTML→テキスト + `spawn('claude', ['-p', prompt])` + JSON parse |
| `service/index.js` | `enqueueSummary(id)` の組み立て |

## 動作

1. `enqueueSummary(id)` で `summaryQueue.enqueue(asyncFn, meta)`
2. queue が前のジョブの promise を待ってから `asyncFn` を実行
3. `asyncFn` 内:
   - `getBookmark` で行 fetch
   - `data/html/<file>` から HTML 読み込み
   - `summarizeWithClaude({url, title, html, claudeBin})` を await
   - 成功: `setSummary(done)` → `enqueueEmbedding(id)` → `emitEvent`
   - 失敗: `setSummary(error)` + throw (queue は次に進む)

## プロンプト

`service/claude.js` の `summarizeWithClaude`:

```
あなたはブックマークの要約担当です。
次の Web ページの内容を読み、以下を JSON 1 オブジェクトのみで出力してください。
{
  "summary": "日本語で 200〜400 文字の要約",
  "categories": ["3〜5 個の短いカテゴリ名 (日本語、各 2〜10 文字)"]
}

TITLE: ...
URL: ...

CONTENT:
<最大 30,000 字のテキスト>
```

## 環境変数

| 変数 | 用途 |
|------|------|
| `MEMORIA_CLAUDE_BIN` | claude バイナリのパス (既定 `claude`) |
| `CLAUDE_CODE_GIT_BASH_PATH` | Windows 必須 — Node spawn から起動するために bash.exe 絶対パス |

## 失敗パターン

- claude CLI が PATH にない → `ENOENT`
- Windows で git-bash 未設定 → "Claude Code on Windows requires git-bash"
- 180 秒タイムアウト → kill SIGKILL + reject
- claude が JSON 以外を返す → `Failed to parse Claude output as JSON`

## 制限

- 1 ジョブ最大 180 秒
- 履歴は in-memory 50 件 (FifoQueue の `historyLimit`)
- 同時実行は 1 (key/quota の理由)

## ロードマップ

- 失敗ジョブの retry ボタン
- prompt のテンプレート化 (カスタマイズ可能に)
- 別キュー (低優先度: 推薦埋込更新等) を追加
