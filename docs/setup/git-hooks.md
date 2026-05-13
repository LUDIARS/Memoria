# git post-commit hook の導入

Memoria は commit を「開発活動」 として記録し、 日記 / 週報の根拠にする。
git の `post-commit` hook を設定すると、 commit するたびに Memoria local backend
の `POST /api/activity/event` が呼ばれて `activity_events.kind='git_commit'` 行が
追加される。

## 自動セットアップ (推奨)

```bash
# Memoria repo のルートで:
node server/hooks/setup.mjs

# 既に global の core.hooksPath を別用途で使ってる場合は repo ごとに入れる:
node server/hooks/setup.mjs --repo /path/to/your-repo

# 何が実行されるか確認するだけ (手動でやる人向け):
node server/hooks/setup.mjs --print
```

これで以下が起きる:

1. `~/.memoria-hooks/` に `post-commit` (shell shim) と `post-commit.mjs` (Node 本体) をコピー
2. `git config --global core.hooksPath ~/.memoria-hooks` を設定
3. 動作確認用の dummy commit でも記録される

既に別の global hook を使っている場合 (例: メモリの `feedback_8686_git_hooks_ignore.md`
で言及されている別ツール用の hook) は、 setup.mjs は **警告して中止** する。
共存させたい場合は手動で:

```bash
# 既存 hooks dir のパスを確認
git config --global core.hooksPath

# その dir に Memoria hooks をコピー (上書き注意)
cp server/hooks/post-commit     <existing-hooks-dir>/post-commit-memoria
cp server/hooks/post-commit.mjs <existing-hooks-dir>/
# 既存 post-commit から `<existing-hooks-dir>/post-commit-memoria` を呼ぶラッパに改修
```

## 動作確認

```bash
# どこかの git repo で
git commit --allow-empty -m "test memoria hook"

# Memoria backend (npm run dev) のログに以下が出れば成功
# [http] {... method: "POST", path: "/api/activity/event", status: 200 ...}
```

stdout/stderr に hook 関連のメッセージが出てしまう場合は、 `MEMORIA_GIT_HOOK_DEBUG=0`
で抑制 (default も silent)。

## トラブルシュート

### コミットメッセージが文字化けする

Windows の OEM code page (= Shift-JIS) が悪さしているはず。 hook は
`git -c i18n.logoutputencoding=utf-8` を内部で使うので、 通常は UTF-8 で
送信される。 それでも化ける場合:

1. PowerShell / git-bash 双方で `git log -1` の表示が正しいか確認
2. `MEMORIA_GIT_HOOK_DEBUG=1 node server/hooks/post-commit.mjs` を実行して
   どの段階で化けるかを切り分け
3. Memoria 受信側で 化けていれば `routes/visit.ts` の JSON parse 周りを疑う

### Memoria backend に届かない

- `curl -i http://localhost:5180/health` で疎通確認
- backend の起動順 (= Memoria が落ちてる時間帯の commit は記録されない、 仕様)
- `MEMORIA_URL` 環境変数が正しいか (`export MEMORIA_URL=http://192.168.x.x:5180` 等)

## AI に頼む場合のプロンプト例

このリポジトリには AI 担当者に貼るだけで導入できるテンプレートを用意してある。

```text
Memoria の git post-commit hook を私の環境に導入してください。

このリポジトリの server/hooks/ に setup.mjs / post-commit / post-commit.mjs が
あるので、以下の前提に従って導入手順を実行 (or 案内) してください:

- 私の OS は <Windows / macOS / Linux>
- 既存の global git hook の使用状況: <未使用 / 8686 系の noise hook を使ってる / 別ツール>
- 既に Memoria local backend が <http://localhost:5180> で動いている
- 動作確認は dummy commit で Memoria backend ログに POST 200 が見えること

setup.mjs を直接実行できる環境なら自動セットアップ、 共存が必要なら手動 merge の
手順を提示してください。 設定後、 私のターミナルで実行すべきコマンドを 1 つずつ
提示し、 私が承認するごとに次へ進めてください (= 一括実行はしない)。
```
