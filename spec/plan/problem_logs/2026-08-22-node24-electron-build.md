# Node 24 で Electron 同梱ビルドが失敗する

- Date: 2026-08-22
- Status: fixed and verified
- Area: desktop release packaging
- Severity: release blocker

## Summary

最新 `main` の Windows Electron ビルドを Node.js 24.14.1 で実行すると、サーバ同梱工程で `better-sqlite3` の導入に失敗した。Node 24 へ統一する方針に対し、CI・同梱ランタイム・型定義が Node 20/22 に分散していた回帰である。

## Evidence

- 2026-08-22、`desktop` で `npm run build:win` を実行。
- `bundle-server.ts` は Node 22.11.0 を同梱対象に表示した一方、`npm install --omit=dev` はホスト Node 24.14.1 で実行された。
- `better-sqlite3@11` の install が `No prebuilt binaries found (target=24.14.1)` を出し、`node-gyp@9.4.1` が Python 3.14 の `ModuleNotFoundError: No module named 'distutils'` で停止した。
- `better-sqlite3@13.0.3` への更新後も、Node 24.19.0 の同梱工程では npm が `binding.gyp` から `node-gyp rebuild` を自動起動し、同じ Python 環境で停止した。
- 公式 CI は server=Node 20、desktop/release=Node 22、portable runtime=22.11.0 と不一致だった。

## Regression Context

Node の対象世代が複数ファイルへ直書きされ、Electron のリリースビルドが Node 24 で継続検証されていなかった。リリース時に初めてネイティブ依存の ABI 非対応が露出する状態だった。

## Cause

Node バージョンの正本がなく、Node 24 の事前ビルドを持たない `better-sqlite3@11` と古い `node-gyp` が残っていた。さらに同梱用の production install が lifecycle script を許可していたため、プリビルドを同梱する新版でも npm の暗黙の `node-gyp rebuild` が実行されていた。

## Fix Requirements

- Node 24 の固定バージョンを一つのファイルで管理する。
- server、desktop、MCP、multi-server、CI、Electron 同梱ランタイムを Node 24 に揃える。
- Node 24 対応の `better-sqlite3` へ更新する。
- 同梱依存の lifecycle script を抑止し、固定した Node 24 で `better-sqlite3` の実ロードを検証する。
- Windows の NSIS インストーラ生成まで成功させる。

## Verification

- Node 24.19.0 環境で `desktop/npm run build:win` が成功した。
- bundled server の production dependency 導入後、`better-sqlite3@13.0.3` でインメモリ DB の生成・終了に成功した。
- portable Node 24.19.0 の SHA256 検証と展開、Electron 33.4.11 packaging、NSIS installer 作成まで成功した。
- `desktop/dist/Memoria Setup 1.0.1.exe` (131,898,529 bytes) を生成した。SHA256 は `7F2CA85DC45554DB356046E0452C90483A985FB3085B9F78877C5F90C02CCFAB`。
- ビルドで置換される `desktop/resources/server/.gitkeep` を復元し、生成物が追跡対象ソースへ差分を残さないことを確認した。

## Follow-up

Revisor/CI で Linux の desktop typecheck と各 OS の release packaging を確認する。
