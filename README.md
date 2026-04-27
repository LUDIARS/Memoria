# Memoria

ローカルで完結する Web ブックマーキングツール。Chrome 拡張で「いま見ているページ」を保存すると、ローカルで動く [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) (`claude` CLI) が**要約とカテゴリを自動生成**し、自前の Web UI から検索・整理・メモできる。

外部クラウドにはデータを送らない（クラウドに行くのは Claude Code 経由の要約リクエストだけ）。

## 主な機能

- **保存**: Chrome 拡張から HTML / URL / タイトルをローカルサーバーに送信
- **要約 + カテゴリ自動生成**: ローカル `claude -p` をサブプロセスで起動、3〜5 個の日本語カテゴリと約 200〜400 字の要約を生成
- **保存ストレージ**: HTML はファイル (`data/html/`)、メタデータは SQLite (`data/memoria.db`)
- **カテゴリ別 UI**: 左サイドバーで絞り込み、カードに要約とカテゴリチップを表示
- **メモ機能**: 各ブックマークに自由記述のメモを追加
- **エクスポート / インポート**: 選択ブックマークを JSON で書き出し / 取り込み（共有用途）
- **アクセス追跡**: 追加日 + 最終アクセス日 + アクセス回数を記録、Chrome 拡張がアクティブタブの URL をサーバーに通知
- **要約キュー**: `claude` CLI 呼び出しを直列化、サーバー再起動時の `pending` 復旧、UI で実行中・順番待ち・履歴を可視化
- **本日の未保存履歴タブ**: 今日アクセスして未保存の URL をリスト → チェックして一括ブックマーク化（サーバー側で fetch）
- **再要約**: 保存済の HTML から要約をやり直す
- **フローティング保存ボタン**: 全ページ右下に常駐、ドラッグで位置移動、クリックで保存

## 構成

```
Memoria/
├ extension/              Chrome 拡張 (Manifest V3)
│  ├ manifest.json
│  ├ background.js        access ping / 拡張<->サーバー間プロキシ
│  ├ content.js           各ページに floating button を Shadow DOM で注入
│  ├ popup.html / .js     ツールバーアイコンの保存ボタン
│  └ options.html / .js   サーバー URL 設定
│
├ server/                 Node.js + Hono + better-sqlite3
│  ├ index.js             HTTP API + 静的配信
│  ├ db.js                SQLite スキーマ + クエリ
│  ├ claude.js            HTML→テキスト抽出 + claude CLI 呼び出し
│  ├ queue.js             FIFO 要約キュー
│  └ public/              SPA (vanilla JS)
│
├ data/                   ★ git 管理外
│  ├ html/                保存 HTML 本体 (1 ページ = 1 ファイル)
│  └ memoria.db           SQLite DB
│
└ README.md
```

## インストール

### 必要環境

| ツール | バージョン | 備考 |
|--------|-----------|------|
| Node.js | 18 以上 | `fetch` / `--watch` 内蔵 |
| npm | 9 以上 | Node.js 同梱で OK |
| Google Chrome | 116 以上 | MV3 対応版 |
| Claude Code CLI | 2.0 以上 | [公式インストール手順](https://docs.claude.com/en/docs/claude-code/quickstart) |
| (Windows のみ) Git for Windows | 任意 | `bash.exe` を `claude` CLI が要求 |

### 1. リポジトリ取得

```bash
git clone https://github.com/LUDIARS/Memoria.git
cd Memoria
```

### 2. サーバーのセットアップ

```bash
cd server
npm install
```

### 3. サーバー起動

#### macOS / Linux

```bash
npm start
# Memoria server listening on http://localhost:5180
```

#### Windows

`claude` CLI は Windows 上で **git-bash** の `bash.exe` を要求します。`CLAUDE_CODE_GIT_BASH_PATH` を指定して起動してください。

PowerShell:

```powershell
$env:CLAUDE_CODE_GIT_BASH_PATH = "C:\Program Files\Git\bin\bash.exe"
npm start
```

Git Bash:

```bash
CLAUDE_CODE_GIT_BASH_PATH="/c/Program Files/Git/bin/bash.exe" npm start
```

未設定だと要約処理が `status="error"` になり、UI の詳細パネルにエラー文が表示されます。

### 4. Chrome 拡張の読み込み

1. Chrome で `chrome://extensions` を開く
2. 右上の **「デベロッパーモード」** を ON
3. **「パッケージ化されていない拡張機能を読み込む」** → このリポジトリの `extension/` ディレクトリを選択
4. Chrome ツールバーに Memoria アイコンが表示される

### 5. 動作確認

1. ブラウザで http://localhost:5180/ を開く（Memoria UI）
2. 別タブで任意の Web ページを開く
3. 右下のフローティングボタン or ツールバーアイコンの「このページを保存」をクリック
4. UI に戻ると新しいカードが「要約中」で現れ、数秒後に要約とカテゴリが入る

## 環境変数

| 変数 | 既定値 | 用途 |
|------|--------|------|
| `MEMORIA_PORT` | `5180` | リッスンポート |
| `MEMORIA_DATA` | `<repo>/data` | DB と HTML 保存ディレクトリ |
| `MEMORIA_CLAUDE_BIN` | `claude` | claude CLI のパス |
| `CLAUDE_CODE_GIT_BASH_PATH` | (未設定) | Windows 用、bash.exe の絶対パス |

例:

```bash
MEMORIA_PORT=6000 MEMORIA_DATA=/var/memoria npm start
```

## 拡張機能の設定

サーバー URL を変更する場合: `chrome://extensions` → Memoria Bookmarker → **詳細** → **拡張機能のオプション**

既定値は `http://localhost:5180`。

## 使い方

### ページを保存する

- フローティングボタン（右下、常駐、ドラッグ移動可）
- ツールバーの Memoria アイコン → 「このページを保存」

どちらでも HTML / URL / タイトルがサーバーに送られ、要約キューに投入されます。同じ URL は二重保存されず、アクセス回数だけ加算されます。

### カテゴリで絞り込む

UI 左サイドバー。各カテゴリには件数バッジが付きます。「すべて」で全件表示。

### メモを書く

カードをクリックして詳細パネルを開き、「メモ」欄に入力 → **保存** ボタン。
カテゴリも同パネルでカンマ区切り編集可。

### 再要約

詳細パネルの **再要約** ボタンで保存済 HTML を Claude にかけ直します（要約と Auto カテゴリのみ更新、メモは保持）。

### エクスポート / インポート

- カードのチェックボックスで複数選択 → ヘッダー右の **Export**
- **Import** → JSON ファイル選択（URL 重複はスキップする merge モード）

### 本日の未保存タブ

- 今日アクセスして未保存の URL を一覧表示
- チェックして **選択をブックマークに保存** → サーバーが fetch して HTML を取得、要約キューへ投入
- ログインが必要なページはサーバー fetch では取れません → 拡張ボタン経由で保存してください

### 要約キュータブ

実行中ジョブ・順番待ち・履歴（最新 50 件、所要時間 / 完了時刻 / エラー文）を表示。

## API

| Method | Path | 用途 |
|--------|------|------|
| `POST` | `/api/bookmark` | ページ保存 (HTML+URL+title)。重複 URL はアクセスのみ記録 |
| `GET`  | `/api/bookmarks?category=&sort=` | 一覧 |
| `GET`  | `/api/bookmarks/:id` | 詳細 |
| `PATCH`| `/api/bookmarks/:id` | メモ・カテゴリ更新 |
| `DELETE`| `/api/bookmarks/:id` | 削除 (HTML ファイルも削除) |
| `GET`  | `/api/bookmarks/:id/html` | 保存 HTML を返す |
| `GET`  | `/api/bookmarks/:id/accesses` | アクセス履歴 |
| `POST` | `/api/bookmarks/:id/resummarize` | 再要約 |
| `GET`  | `/api/categories` | カテゴリ一覧 (件数付き) |
| `POST` | `/api/access` | URL+title を upsert、ブックマークがあればアクセス記録 |
| `GET`  | `/api/visits/unsaved` | 本日 & 未ブックマークの URL 一覧 |
| `GET`  | `/api/visits/unsaved/count` | 件数のみ |
| `POST` | `/api/visits/bookmark` | `{urls[]}` を fetch して保存 |
| `DELETE`| `/api/visits` | `{urls[]}` を履歴から削除 |
| `POST` | `/api/export` | `{ids?, includeHtml?}` → エクスポート JSON |
| `POST` | `/api/import` | `{bookmarks: [...]}` を取り込み |
| `GET`  | `/api/queue` | キュー深度 + running |
| `GET`  | `/api/queue/items` | キューと履歴のスナップショット |

## エクスポートフォーマット

```json
{
  "version": 1,
  "exported_at": "2026-04-27T...",
  "bookmarks": [
    {
      "url": "...",
      "title": "...",
      "summary": "...",
      "memo": "...",
      "categories": ["..."],
      "created_at": "...",
      "last_accessed_at": "...",
      "access_count": 7,
      "html": "<!DOCTYPE html>..."
    }
  ]
}
```

## トラブルシューティング

### 要約が `status=error` になる

- **Windows**: `CLAUDE_CODE_GIT_BASH_PATH` が未設定。`bash.exe` のパスを指定して再起動
- **権限**: `claude` CLI に Anthropic API キー or サブスクリプションが紐付いているか確認 (`claude -p "test"` を手動実行して通るか)
- **タイムアウト**: 30 KB を超える長文ページは先頭 30,000 字に切り詰めますが、それでも 180 秒で打ち切ります

### Chrome 拡張のフローティングボタンが出ない

1. `chrome://extensions` で **Memoria Bookmarker** を **🔄 リロード**
2. 確認ページを **F5** で再読み込み（content_scripts は新規ロード時のみ注入）
3. ページで F12 → Console に `[Memoria] content script loaded on ...` が出るか確認
4. `chrome://`, `chrome-extension://`, PDF ビューア, Web Store では Chrome の制限により注入されない

### サーバーが起動しない

- ポート競合: `MEMORIA_PORT=5181` などで変更
- `better-sqlite3` ビルド失敗: Windows なら Python 3 + Visual Studio Build Tools、macOS/Linux なら build-essential 系を入れて `npm install` 再実行

### `data/html/` の容量が増えすぎた

ブックマークを削除すると対応 HTML ファイルも削除されます。長期間使うと累積するので、不要なものは UI から削除してください。

## 既知の制限

- 解析は Anthropic 公式 Chrome 拡張「Claude in Chrome」とは連携できない（公開 API なし、2026-04 時点）→ ローカル `claude` CLI を使用
- `text/html` 系の Content-Type 以外（PDF / JSON / 画像）はサーバー fetch では保存できない
- 認証が必要なページは Chrome 拡張ボタン経由でしか保存できない（ログイン状態を再現できないため）
- データ複数端末同期は無し（個人ローカル運用想定）

## MCP (Model Context Protocol) として使う

`mcp-server/` 配下に Memoria を MCP サーバーとして公開する実装が含まれています。Claude Desktop / Claude Code から自分のブックマーク資産を直接検索・保存・要約できます。

### セットアップ

```bash
cd mcp-server
npm install
```

Claude Desktop の `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`、Windows: `%APPDATA%\Claude\`) に追加:

```json
{
  "mcpServers": {
    "memoria": {
      "command": "node",
      "args": ["/abs/path/to/Memoria/mcp-server/index.js"],
      "env": { "MEMORIA_URL": "http://localhost:5180" }
    }
  }
}
```

Claude Code は `~/.claude/mcp.json` (プロジェクト固有なら `.claude/mcp.json`) に同じ形式で書けます。

### 公開している Tools

| name | 用途 |
|------|------|
| `search_bookmarks` | タイトル/URL/要約/メモを横断する部分一致検索 |
| `get_bookmark` | id 指定で詳細取得 (HTML 本体も任意で含める) |
| `save_url` | サーバー fetch でブックマーク化 |
| `list_categories` | カテゴリ一覧 + 件数 |
| `get_unsaved_visits` | 過去 N 日間の未保存訪問 (保存漏れスコア付き) |
| `recent_bookmarks` | 最新の保存 |

`memoria://bookmark/<id>` リソースで個別ブックマークの Markdown 表現も取得できます。

## ロードマップ

将来的に追加を予定している機能。詳細は GitHub Issues 参照。

- [ ] **検索・閲覧傾向の分析ダッシュボード** ([#1](https://github.com/LUDIARS/Memoria/issues/1)) — カテゴリ・タイトル・要約・アクセス履歴から自分の調査傾向を可視化
- [ ] **関心領域に基づく技術サイト推薦** ([#2](https://github.com/LUDIARS/Memoria/issues/2)) — 傾向データから未訪問の関連サイトを提案 (#1 をベースに)
- [ ] **ドメイン基準の保存漏れサジェスト** ([#3](https://github.com/LUDIARS/Memoria/issues/3)) — 同一ドメインで保存済の記事がある未保存 URL をハイライト
- [ ] **「ディグる」タブ — Deep Research 風の探索 UI** ([#4](https://github.com/LUDIARS/Memoria/issues/4)) — 単語/センテンスを入力 → Web 検索 → ソースをリスト+グラフ表示 → 選択して要約
- [ ] **Skill / MCP として外部から呼び出せるようにする** ([#5](https://github.com/LUDIARS/Memoria/issues/5)) — Claude Code / Claude Desktop / 他 MCP クライアントから検索・保存・要約を直接利用
- [ ] **保存済ブックマークの RAG 化 (ベクトル検索)** ([#6](https://github.com/LUDIARS/Memoria/issues/6)) — 本文を埋め込みベクトル化、意味検索 + 自前蔵書を使った Q&A

## ライセンス

MIT (詳細は LICENSE)
