# ローカルで起動するための設定

## 目的

個人 PC で Memoria server を立ち上げ、 `http://localhost:5180/` を開けるようにする。
LLM や GPS 等の機能設定はここでは扱わない (各用途ガイド参照)。 ここで決めるのは
**ポート / データ保存先 / claude CLI 経路** だけ。

ふつうのユーザはサーバを直に立てず **デスクトップアプリ (Electron)** を使う
([`../../README.md`](../../README.md) の A 章)。 このガイドは server 直起動
(開発者 / カスタム運用 / CI) 向け。

## 必要な設定キー

すべて任意。 何も渡さなくても既定値で起動する。

| キー | env | 既定 | 説明 | 根拠 |
|---|---|---|---|---|
| ポート | `MEMORIA_PORT` | `5180` | Hono の listen port | `server/index.ts:71` |
| データ保存先 | `MEMORIA_DATA` | `<repo>/data` | SQLite + HTML + meals + diary | `server/index.ts:72` |
| claude CLI パス | `MEMORIA_CLAUDE_BIN` | `claude` | claude CLI バイナリ (PATH に無いとき) | `server/index.ts:76` |
| bash パス (Windows) | `CLAUDE_CODE_GIT_BASH_PATH` | (自動検出) | git-bash 絶対パス。 app_settings `runtime.git_bash_path` が優先 | `server/llm.ts:141` |

> `MEMORIA_CLAUDE_BIN` / `CLAUDE_CODE_GIT_BASH_PATH` は LLM 用なので、 起動後に
> ⚙ AI 設定パネルから入れる方が推奨 (UI 値が env より優先)。 詳しくは
> [`llm-providers.md`](./llm-providers.md)。

## 手順

```bash
cd server
npm install
npm start          # → http://localhost:5180/
```

- `npm start` は内部で `npm run build:frontend` (esbuild で SPA をバンドル) を
  prestart に走らせてから `tsx bootstrap.ts` を起動する (`server/package.json:7-8`)。
- 開発時は `npm run dev` (`tsx watch` で自動再起動 / `server/package.json:10`)。

ポート・データ保存先を変えたいときだけ env を渡す:

```bash
MEMORIA_PORT=6000 MEMORIA_DATA=/var/memoria npm start
```

データディレクトリ (`<repo>/data` 既定) は git 管理外。 起動時に `html/` `meals/`
が自動作成され、 SQLite は `<dataDir>/memoria.db` に作られる (`server/index.ts:73-80`)。

## 注意点

- **`node --watch` は使わない**。 Memoria は新規 export を `node --watch` が拾わず
  404 になる既知問題がある。 開発時の自動再起動は **`tsx watch` を使う `npm run dev`**
  を使うこと。 手動再起動が必要になったら一度プロセスを完全に kill してから
  `npm start` / `npm run dev` を入れ直す ([[feedback_node_watch_stale]])。
- **env ファイルは `server/.env.secrets` だけ読まれる**。 `npm start` /
  `npm run dev` は `tsx --env-file-if-exists=.env.secrets` で起動するので
  (`server/package.json:8,10`)、 `.env` という名前のファイルは自動では読まれない。
  恒久的に env を渡したいなら shell export か `.env.secrets` に書く。
- **Infisical は通常不要**。 `server/bootstrap.ts` は Infisical を使わず index.ts を
  import するだけ (`server/bootstrap.ts:1-14`)。 `INFISICAL_*` / `npm run env:*` は
  Hub 連携や集中管理をする上級者向けで、 ローカル単体運用では触らなくてよい。
- **Windows + claude CLI** は `bash.exe` を要求する。 自動検出される一般的な
  インストール先 (`C:\Program Files\Git\bin\bash.exe` 等) にあれば空欄で動くが、
  別の場所なら `runtime.git_bash_path` (UI) か `CLAUDE_CODE_GIT_BASH_PATH` (env) を
  設定する ([`../../README.md`](../../README.md) の B 章)。

## トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| ポートが既に使われている | 古い node プロセスが残っている。 完全に kill してから再起動 |
| 新規 API が 404 | `node --watch` で起動している → `npm run dev` (tsx watch) に切替 + プロセス再投入 ([[feedback_node_watch_stale]]) |
| frontend が古いまま | `npm run build:frontend` が走っていない。 `npm start` で prestart が走る。 開発時は `npm run watch:frontend` を別ターミナルで |
| claude CLI が動かない (Windows) | `CLAUDE_CODE_GIT_BASH_PATH` 未設定 / 誤り。 git-bash の絶対パスを入れる |
| data が消える / 別ドライブに置きたい | `MEMORIA_DATA` で保存先を指定。 既存 data をコピーしてから切り替える |

## 関連

- [`README.md`](./README.md) — 設定の優先順位 (config/env 解決順)
- [`config-reference.md`](./config-reference.md) — 全キー一覧
- [`../../README.md`](../../README.md) — 3 つの動かし方 (Desktop / server / Hub)
