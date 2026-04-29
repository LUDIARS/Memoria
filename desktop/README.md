# Memoria Desktop (Tauri)

Tauri 2.x ラッパー。既存の Memoria Node サーバを子プロセスとして起動し、ローカルの `http://localhost:5180/` を WebView で表示します。

## 必要なもの

- Rust toolchain (`rustup default stable`)
- Tauri CLI: `cargo install tauri-cli --version "^2.0"`
- Node 22 LTS+ (Memoria サーバ実行用)
- Windows: Microsoft Edge WebView2 (Win10/11 にプリインストール済)
- macOS: Xcode CLI tools
- Linux: `webkit2gtk-4.1` + `libssl-dev`

## 開発実行

```bash
# ターミナル A: Memoria サーバを起動
cd ../server
npm install
npm start

# ターミナル B: Tauri 開発ビルド (内部で WebView が localhost:5180 を読みにいく)
cd ../desktop
cargo tauri dev
```

`cargo tauri dev` はサーバが立ち上がっていることを前提にします。サーバが落ちている場合は WebView が「接続できません」を表示します。

## サーバ自動起動 (production build)

`cargo tauri build` で生成されるバイナリは、起動時に `node ./server/index.js` を子プロセスとして起動します:

- `MEMORIA_SERVER_DIR`: server ディレクトリの絶対パス (デフォルト: 実行バイナリの隣の `server/`)
- `MEMORIA_NODE_BIN`: Node 実行ファイル (デフォルト: `node`)
- `MEMORIA_PORT`: サーバポート (デフォルト: 5180)

production 配布時は server/ ディレクトリ + node_modules/ を同梱する必要があります。詳細は `desktop/src-tauri/tauri.conf.json` の `bundle.resources` を編集してください (本 PR の時点では未設定 — Node 同梱方針が決まり次第対応)。

## ビルド

```bash
cd desktop
cargo tauri build
```

成果物:
- Windows: `src-tauri/target/release/bundle/msi/` または `nsis/`
- macOS: `src-tauri/target/release/bundle/dmg/`
- Linux: `src-tauri/target/release/bundle/deb/` 等

## 既知の制約

- 現状サーバ自動起動は production build のみ。dev ビルドは server を別ターミナルで起動する必要あり
- Node 本体は同梱しない (ユーザの PATH に入っている前提)。これは将来 [pkg](https://github.com/vercel/pkg) や [Bun --compile](https://bun.sh/docs/bundler/executables) で単一バイナリ化することで解消予定
- アイコン: `desktop/src-tauri/icons/` に空のプレースホルダしか入っていません。本番リリースまでにブランド画像を差し替えてください
