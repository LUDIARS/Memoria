# Memoria

ローカル完結型のブックマーク + ディグ (deep research) + 日記 + ドメイン辞書ツール。
Chrome 拡張で「いま見ているページ」を保存すると、ローカルで動く Claude Code
(`claude` CLI) が要約・カテゴリ・タイトル・サイトの分類を自動生成し、自前の
Web UI から検索・整理・調査・日記化できる。

外部に出るのはユーザが意図的にシェアしたものだけ。デフォルトの個人モード
ではブックマーク本体・履歴・日記など個人データはすべて手元の SQLite に
留まる。

---

## 3 つの動かし方

| | 誰向け | やること |
|---|---|---|
| **デスクトップアプリ** | ふつうのユーザ | インストーラを実行するだけ。Node もサーバも同梱、設定はアプリ内 UI |
| **server 直起動** | 開発者 / カスタム運用 | `npm install && npm start`。Chrome 拡張は別途 |
| **マルチサーバ (Memoria Hub)** | 共有ハブを建てたい人 | `docker compose up`。Cernere SSO 必須、ローカルとは別物 |

ふつうの利用は **デスクトップアプリ** で完結する。サーバを直に立てる
必要はない。

---

## A. デスクトップアプリ (推奨)

[Tauri 2.x](https://tauri.app/) 製。インストーラには Memoria サーバ + Node
ランタイムが同梱されているので、ユーザは何もインストールしなくていい。

### 1. インストール

リリースから配布物を取得 (Windows: `.msi` / macOS: `.dmg` / Linux: `.deb` 等)。
リリースがまだない場合の自前ビルドは [`desktop/README.md`](desktop/README.md) 参照。

### 2. 起動 → ほぼ何もしない

アプリを起動すると裏で Memoria サーバが立ち上がり、WebView が
`http://localhost:5180/` を表示する。

最低限必要な設定はぜんぶ右上 **⚙ AI** ボタンの中:

- **タスク別プロバイダ** (Claude / Gemini / Codex / OpenAI API)
- **CLI バイナリパス** (PATH に通っていない場合のみ)
- **🐚 Bash (Windows のみ)** — git-bash の絶対パス。Memoria が一般的な
  インストール先 (`C:\Program Files\Git\bin\bash.exe` 等) を自動検出
  するので、空欄のままで大体動く
- **OpenAI API Key** (gpt 系を使うとき)
- **🌐 マルチサーバ URL** (共有ハブに接続するとき)
- **🛠 ランタイム情報** (port / data dir / platform — 表示のみ)

これらはすべて SQLite の `app_settings` に保存され、再起動しても残る。
環境変数の手動設定は **不要**。

### 3. Chrome 拡張のインストール

ブラウザから保存するには Chrome 拡張が必要。

1. Chrome で `chrome://extensions`
2. 右上 **デベロッパーモード** ON
3. **「パッケージ化されていない拡張機能を読み込む」** → このリポの `extension/`
4. ツールバーに Memoria アイコンが出る

拡張のサーバ URL は既定で `http://localhost:5180`。

---

## B. server 直起動 (開発者向け)

CI を回したり、コードを触ったり、複数台で運用したいとき。

### 必要環境

| ツール | バージョン | 備考 |
|---|---|---|
| Node.js | 22 LTS+ | `--env-file-if-exists` を使う |
| npm | 10+ | Node 同梱 |
| Claude Code CLI | 最新 | `claude -p "hi"` が動くこと |
| Chrome | MV3 対応版 | 拡張を読み込むときだけ |
| Git for Windows | 任意 | Windows で `claude` CLI が `bash.exe` を要求するため |

### 起動

```bash
git clone https://github.com/LUDIARS/Memoria.git
cd Memoria/server
npm install
npm start
# → http://localhost:5180/
```

開発時は `npm run dev` (Node の `--watch` で自動再起動)。

### 設定はすべて UI から

`MEMORIA_PORT` / `MEMORIA_DATA` / `MEMORIA_CLAUDE_BIN` /
`CLAUDE_CODE_GIT_BASH_PATH` を環境変数で渡してもいいが、**通常は
不要** で、起動後 ⚙ AI 設定パネルから入力するだけで十分。env と UI
両方に値があれば UI の値が優先される。

ポート / データディレクトリだけは起動前に決まるので、変更したい場合
だけ env で渡す:

```bash
MEMORIA_PORT=6000 MEMORIA_DATA=/var/memoria npm start
```

### ディレクトリ構成

```
Memoria/
├ extension/        Chrome 拡張 (MV3)
├ server/           Node.js + Hono + better-sqlite3
│  ├ index.js       HTTP API + 静的配信
│  ├ db/            SQLite façade (Phase 0 シーム)
│  ├ db.js          スキーマ + クエリ (legacy export)
│  ├ claude.js      HTML→テキスト + claude CLI 呼出し
│  ├ llm.js         プロバイダ切替 (claude/gemini/codex/openai)
│  ├ dig.js         ディグ deep research
│  ├ diary.js       日記 + 週報
│  ├ domain-catalog.js  ドメイン分類 (site_name + できること自動推論)
│  ├ page-metadata.js   per-URL meta + kind
│  ├ wordcloud.js   ワードクラウド
│  ├ recommendations.js おすすめ
│  ├ queue.js       FIFO キュー
│  ├ local/         ローカル専用 (uptime, multi-client)
│  ├ multi/         マルチサーバ (Memoria Hub) — 別 Node プロセス
│  ├ types/         JSDoc から参照する .d.ts (Phase 1 TS migration)
│  └ public/        SPA (vanilla JS)
│
├ desktop/          Tauri ラッパ + bundle スクリプト
├ docs/             設計書 (multi-server-architecture.md, mobile-share.md)
├ mcp-server/       MCP として外部公開する実装 (Claude Desktop / Code 連携)
└ data/             ★ git 管理外 (HTML + SQLite)
```

---

## C. マルチサーバ (Memoria Hub) を建てる

辞書 / ディグ / ブックマークを **複数ユーザで共有** するハブ。Cernere
SSO で認証する別プロセス、Postgres 必須。個人利用の Memoria を 1 人で
動かすぶんにはいらない。

詳細は [`server/multi/README.md`](server/multi/README.md) と
[`docs/multi-server-architecture.md`](docs/multi-server-architecture.md)。

### docker compose で建てる (Phase 7)

```bash
cd server/multi
cp .env.example .env
# 編集: MEMORIA_CERNERE_*, MEMORIA_JWT_SECRET, MEMORIA_HUB_BASE,
#       POSTGRES_PASSWORD は最低限変更

docker compose up -d --build
docker compose logs -f hub
curl http://localhost:5280/healthz
```

ローカル Memoria の AI 設定 → 🌐 マルチサーバ にこの URL を入れて接続
すると、

- 自分のブックマーク / ディグ / 辞書を **📤 シェア**
- ハブの公開エントリを **🌐 マルチタブ** で閲覧
- 気に入ったエントリを **📥 ダウンロード** してローカルに取り込む
- admin / mod ロールがあれば **🛡 モデレーション** タブで非表示処理

ができる。本番 Cernere OAuth クライアント登録は
[`server/multi/README.md`](server/multi/README.md#cernere-oauth-クライアント登録ランブック)
の手順を参照。

---

## 主な機能

- **保存**: Chrome 拡張から HTML / URL / タイトルをサーバへ送信
- **要約 + カテゴリ自動生成**: ローカル `claude` CLI でローカル完結
- **ワードクラウド + ディグ**: WebSearch + 引用元リスト + 関連語グラフ
- **日記 + 週報**: 訪問ドメイン + ブックマーク + GitHub commits を統合し
  Sonnet → 決定論集計 → Opus 1M でハイライト生成
- **ドメイン辞書**: 各サイトの `site_name`, できること, kind を Sonnet が
  自動分類
- **ページメタ**: per-URL の og:* + kind を Sonnet が分類
- **作業キュー**: 1 件ずつ表示 (running + 待機 + 履歴)
- **PWA share_target** (Android) + iOS Shortcut テンプレート
  ([`docs/mobile-share.md`](docs/mobile-share.md))
- **マルチ LLM プロバイダ**: タスク別に Claude / Gemini / Codex / OpenAI
- **マルチサーバ連携**: Cernere SSO + シェア / ダウンロード /
  モデレーション

## 環境変数 (省略可)

UI 設定が無い限り使うのは port / data dir くらい。

| 変数 | 既定 | 用途 |
|---|---|---|
| `MEMORIA_PORT` | `5180` | リッスンポート |
| `MEMORIA_DATA` | `<repo>/data` | DB と HTML 保存先 |
| `MEMORIA_DB_KIND` | `sqlite` | DB アダプタ (Phase 2 で `postgres` 追加予定) |
| `MEMORIA_CLAUDE_BIN` | `claude` | claude CLI のパス (UI が優先) |
| `CLAUDE_CODE_GIT_BASH_PATH` | (Windows のみ) | bash.exe 絶対パス (UI が優先) |
| `MEMORIA_GH_TOKEN` / `MEMORIA_GH_USER` | – | 日記が GitHub commits を引くとき (UI 優先) |

## ライセンス

MIT
