# Memoria Desktop (Electron)

Electron ラッパー。既存の Memoria Node サーバを子プロセスとして起動し、
ローカルの `http://localhost:5180/` を Chromium ウィンドウで表示します。

> 以前は Tauri 2.x で実装されていましたが、 (a) Memoria が元々 Node
> サーバを必要とするので Tauri のバイナリサイズ優位が +60MB の Node
> 同梱で相殺される、 (b) PWA / ServiceWorker / WebPush の挙動が WebKit
> 系で揺れる、 (c) 保守言語を JS/TS に一本化したい、 という理由で
> Electron に置き換えました (詳細は PR 参照)。

## 常駐モデル

Memoria サーバは **常駐型** として動かすことを前提に設計されています:

- ウィンドウの × ボタンを押しても アプリは終了しない (タスクトレイへ
  最小化)。 サーバプロセスは生き続け、 Chrome 拡張 / モバイル PWA から
  `http://localhost:5180/api/*` を叩き続けられます。
- 完全に終了するにはタスクトレイ右クリック → **「Memoria を終了」**。
- **「ログイン時に自動起動」** をトレイメニューから ON にすると、
  OS ログイン時に `--hidden` フラグでウィンドウなし起動 (= 純粋に
  サーバだけ立ち上がる) になります。 ウィンドウはトレイ左クリック
  またはダブルクリックで開けます。

| OS | 自動起動の仕組み |
| --- | --- |
| Windows | `app.setLoginItemSettings({ openAtLogin: true })` → スタートアップ登録 (HKCU\\...\\Run)。 ユーザー権限のみで動作 |
| macOS | LaunchAgent `~/Library/LaunchAgents/<bundle-id>.plist` |
| Linux | xdg-autostart `~/.config/autostart/Memoria.desktop` (パッケージ AppImage / .deb 経由でインストールされている場合) |

すべて **ユーザー権限** で動くスタートアップ登録なので、 管理者権限は
不要 / インストーラの追加権限要求もありません。

### Windows サービス化 (Phase 2、 別 PR)

「ユーザーログアウト中も常時動かしたい」 「複数ユーザーで Memoria
サーバを共有したい」 といった用途には Windows サービス化 (sc create /
node-windows) が向いています。 こちらは管理者権限が必要 + インストーラ
側で UAC 昇格が要るため、 別の PR で扱います。 当面は LoginItem
ベースの自動起動で十分なはず。

## 必要なもの

- Node 22 LTS+
- Windows: 不要 (Chromium 同梱)
- macOS: 不要 (Chromium 同梱)
- Linux: AppImage 実行に `libfuse2` が必要な場合あり

## 開発実行

```bash
# ターミナル A: Memoria サーバを起動 (この子プロセスを Electron が
# 起動できるよう、 server/ 側で `npm install` 済みにしておくこと)
cd ../server
npm install
npm start

# ターミナル B: Electron を起動 (UI が localhost:5180 を読みにいく)
cd ../desktop
npm install
npm run dev    # 内部で tsc → electron . を起動
```

`npm run dev` は predev で `tsc` を走らせて `src/main.ts` `src/preload.ts`
を `out/main.js` `out/preload.js` にコンパイルしたあと `electron .` を
呼びます。 `out/main.js` がローカルの `../server/index.js` を子プロセスと
して自動 spawn します。 別端末で server を立ち上げ済みの場合は、 既存
サーバがそのまま使われます (UI 側ではどちらでも見分けはつきません)。

### TypeScript 構成

| パス | 役割 | 出力 |
| --- | --- | --- |
| `src/main.ts` | Electron メインプロセス (server spawn / tray / login item / IPC) | `out/main.js` (CommonJS) |
| `src/preload.ts` | renderer に `window.memoria.{getAutoLaunch,setAutoLaunch,hide,quit,getServerPort}` を expose | `out/preload.js` |
| `scripts/bundle-server.ts` | リリース時に server + Node を `resources/` に展開 | `tsx` で実行 (コンパイルなし) |
| `scripts/generate-icons.ts` | プレースホルダ icon 生成 | 同上 |

`tsconfig.json` が src/ 用 (CommonJS、 `out/` に出力)、
`tsconfig.scripts.json` が scripts/ 用 (型チェックのみ、 ESNext)。
`npm run typecheck` で両方走ります。

## 配布パッケージのビルド

`npm run build` 時に以下が走ります:

1. `scripts/bundle-server.mjs` がサーバ + Node ランタイムを `resources/` に展開
   - `resources/server/` ← Memoria の `server/` ディレクトリをコピー +
     `npm install --omit=dev` で本番 deps だけ入れる
   - `resources/node/<plat>/` ← nodejs.org から SHA256 検証済みの portable
     Node ランタイムを展開
2. `electron-builder` が Electron + 上記 `resources/` を 1 つのインストーラ
   にパッケージング

`package.json` の `build.extraResources` で `resources/` がインストーラに
同梱され、 `main.cjs` は実行時に `process.resourcesPath` から server と
Node を解決して `node index.js` を spawn します。 **ユーザの環境に
Node を入れる必要はありません。**

```bash
cd desktop
npm install
npm run build           # ホスト OS 向け
npm run build:win       # Windows x64 (NSIS インストーラ)
npm run build:mac       # macOS arm64 (.dmg)
npm run build:linux     # Linux x64 (AppImage + .deb)
```

成果物は `desktop/dist/` 以下に出力されます。

### 解決順 (env override)

| 設定 | 解決順 |
| --- | --- |
| `MEMORIA_NODE_BIN` | env → `resources/node/<plat>/...` (同梱) → Electron 自身 (`ELECTRON_RUN_AS_NODE=1`) → PATH の `node` |
| `MEMORIA_SERVER_DIR` | env → `resources/server/` (同梱) → `../server/` (リポジトリ内 dev) |
| `MEMORIA_PORT` | env (デフォルト 5180) |

### bundle-server.mjs オプション

- `--node-version=<x.y.z>` (default `22.11.0`)
- `--platform=<win-x64|darwin-arm64|darwin-x64|linux-x64|linux-arm64>`
  (default: ホスト)
- `--skip-node` または `MEMORIA_SKIP_NODE=1` で Node 同梱をスキップ。
  この場合 `main.cjs` は Electron を Node として実行 (`ELECTRON_RUN_AS_NODE`)
  にフォールバックします — 配布サイズが小さくなる代わりに、 Claude /
  Gemini CLI のような子プロセスから普通の `node` を呼べないので
  Memoria の AI 機能の一部が動かなくなります。 通常は同梱を推奨。

ダウンロード済みの tarball は `desktop/.cache/node/` にキャッシュされます。
クリーンしたいときはこのディレクトリを削除してください。

## アイコン

`scripts/generate-icons.mjs` が Memoria ブルー (#2a6df4) の単色プレース
ホルダ (PNG / ICO / ICNS) を `icons/` に生成します。 本番リリース前に
1024×1024 の `icon.png` を `icons/` に手動で置けば、 electron-builder
が各プラットフォーム向けの形式に変換してくれます (この場合は generate
スクリプトを呼ばずに `icon.png` を直接 commit してください)。

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
# (desktop/package.json の version も合わせる)
git tag v0.1.0
git push origin v0.1.0
```

タグが push された瞬間に GitHub Actions の `Desktop Release` ワークフロー
が起動し、 3 OS で並列ビルド → アーティファクトを集約 →
`Memoria-v0.1.0-windows-x64.zip` 等の名前で Release にアップロード
されます。

### 手動トリガ

リリースを切らずに動作確認したい場合は Actions タブから **Run
workflow** で `tag` を指定すれば、 タグが無くても作成 + Release を建てて
zip を貼り付けます (`v0.0.0-dev` がデフォルト)。

## 既知の制約

- **better-sqlite3 はネイティブモジュール**なので、 bundle-server.mjs は
  ホスト OS と同じプラットフォーム向けにしか正しい `node_modules` を
  作れません。 クロスビルドするときは別途その OS で `npm install` を
  済ませた `server/` を渡してください (CI は OS 毎にランナーが分かれて
  いるのでこの問題は出ません)
- アイコンは現状プレースホルダ。 本番ブランディング時に差し替え
- macOS の codesign / notarize はまだ実装していません — DMG は
  「未確認の開発元」ダイアログ越しでしか起動できない状態です
- 自動アップデート (`electron-updater`) も未実装。 アップデートは
  毎回インストーラ再ダウンロードしてください
