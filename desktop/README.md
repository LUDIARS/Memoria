# Memoria Desktop (Tauri)

Tauri 2.x ラッパー。既存の Memoria Node サーバを子プロセスとして起動し、ローカルの `http://localhost:5180/` を WebView で表示します。

## 必要なもの

- Rust toolchain (`rustup default stable`)
- Tauri CLI: `cargo install tauri-cli --version "^2.0"`
- Node 22 LTS+ (開発時、ローカルサーバ起動 + bundle スクリプト用。ユーザ側には不要)
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

## サーバ + Node ランタイム同梱 (production build)

`cargo tauri build` 時に `desktop/scripts/bundle-server.mjs` が走り、

- `desktop/src-tauri/resources/server/` ← Memoria の `server/` ディレクトリ
  をコピー + `npm install --omit=dev` で本番 deps だけ入れる
- `desktop/src-tauri/resources/node/<plat>/` ← nodejs.org から SHA256 検証
  済みの portable Node ランタイムを展開

を準備します。`tauri.conf.json` の `bundle.resources` でこれらが
インストーラに同梱され、`main.rs` は実行時に `BaseDirectory::Resource`
からそれぞれを解決して `node index.js` を spawn します。**ユーザの環境に
Node を入れる必要はありません。**

優先順位:

| 設定 | 解決順 |
| --- | --- |
| `MEMORIA_NODE_BIN` | env → bundled node → PATH の `node` |
| `MEMORIA_SERVER_DIR` | env → bundled server → exe 隣の `server/` |
| `MEMORIA_PORT` | env (デフォルト 5180) |

dev 中は bundle 化されていないので、`cargo tauri dev` 時はサーバを別ターミナルで `npm start` してください。

## ビルド

```bash
cd desktop

# サーバ + Node ランタイムを resources/ に整える (≈ 80MB)
node scripts/bundle-server.mjs --node-version=22.11.0
# 別アーキ向けに作るときは --platform=darwin-arm64 等

# Tauri バンドル
cargo tauri build
```

`cargo tauri build` の `beforeBuildCommand` で `bundle-server.mjs` が
自動実行されるので、通常は明示的に走らせる必要はありません。

成果物:
- Windows: `src-tauri/target/release/bundle/msi/` または `nsis/`
- macOS: `src-tauri/target/release/bundle/dmg/`
- Linux: `src-tauri/target/release/bundle/deb/` 等

### bundle-server.mjs オプション

- `--node-version=<x.y.z>` (default `22.11.0`)
- `--platform=<win-x64|darwin-arm64|darwin-x64|linux-x64|linux-arm64>`
  (default: ホスト)

ダウンロード済みの tarball は `desktop/.cache/node/` にキャッシュされます。
クリーンしたいときはこのディレクトリを削除してください。

### サイズ削減 (将来の検討)

現状は portable Node 同梱で配布サイズは ~80MB。`pkg` か `bun --compile`
を使えば server を単一バイナリ化して 30MB 程度まで縮められる見込みです
が、依存 (better-sqlite3 のネイティブビルド) との相性検証が必要なので
別 PR で扱います。

## GitHub Release への配布

`.github/workflows/desktop-release.yml` がタグ push をトリガに

- Windows: NSIS `.exe` インストーラ
- macOS arm64: `.dmg`
- Linux x64: `.AppImage` + `.deb`

をビルドし、それぞれ **zip に固めて** GitHub Release にアタッチします
(ユーザの要望: 生 exe をそのまま置かない)。

### リリース手順

```bash
# version を bump して tag
# (desktop/src-tauri/tauri.conf.json と Cargo.toml の version も合わせる)
git tag v0.1.0
git push origin v0.1.0
```

タグが push された瞬間に GitHub Actions の `Desktop Release` ワークフロー
が起動し、3 OS で並列ビルド → アーティファクトを集約 →
`Memoria-v0.1.0-windows-x64.zip` 等の名前で Release にアップロード
されます。

### 手動トリガ

リリースを切らずに動作確認したい場合は Actions タブから **Run
workflow** で `tag` を指定すれば、タグが無くても作成 + Release を建てて
zip を貼り付けます (`v0.0.0-dev` がデフォルト)。

### マシンが足りないとき

GitHub Actions の Windows / macOS / Linux ランナーをそれぞれ使うので
セルフホストランナーは不要。Release の作成権限のみ必要 (`contents: write`
は workflow 内で宣言済み、PAT は不要)。

## 既知の制約

- アイコン: `desktop/src-tauri/icons/` に空のプレースホルダしか入って
  いません。本番リリースまでにブランド画像を差し替えてください
- `cargo tauri build` 時にホスト != ターゲットアーキでビルドする場合は
  `--platform` オプションで Node tarball も合わせる必要があります
- better-sqlite3 はネイティブモジュールなので、bundle-server.mjs は
  ホスト OS と同じプラットフォーム向けにしか正しい `node_modules` を
  作れません。クロスビルドするときは別途その OS で `npm install` を
  済ませた server/ を渡してください
