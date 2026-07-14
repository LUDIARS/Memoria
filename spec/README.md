# `spec/` — Memoria 仕様書

Memoria のローカルサーバ（Node + better-sqlite3 + Hono）+ desktop / extension /
mcp-server の仕様を集約する。AIFormat
[`FORMAT_SPEC.md`](https://github.com/LUDIARS/AIFormat/blob/main/FORMAT_SPEC.md)
の 6 分類に整理する。TypeScript の型定義（`server/db/types/`,
`server/api/types/`）と 1 対 1 で対応する。

## 構成

```
spec/
├── data/        ← SQLite テーブル定義 (列・index・制約)  ※旧 db/
├── feature/     ← 機能仕様 (シェア可能性 + プライバシー注記、1 機能 1 ファイル)
├── interface/   ← HTTP API 契約 (request / response)     ※旧 api/
│   └── schema/  ← JSON Schema (ludiars-app-manifest)
├── setup/       ← セットアップ・各種設定
└── test/        ← テスト設計
```
> `plan/` は未設置（ロードマップは GitHub Issues / CLAUDE.md）。

## ルール
- **正本は spec**。実装の TS 型はここから生やす。
- **対応する .md / .ts を 1 セットで変更**する（spec だけ・型だけの更新は禁止）。
- **段階移行中**: 既存の `server/db.ts` の CREATE TABLE は引き続き正本。`data/` は
  そこから型化を進める出発点。Phase 後半で実装側を spec から再生成する形に倒す。

## カバレッジ（充実度の現状）
- `data/` — 43 テーブル中 20 を文書化（残りは内部/キャッシュ系。Phase 0 段階移行中、gap）。
- `interface/` — 24 ルート中 17 を文書化（packet-monitor / transit / weather / repo /
  staleness / review 等が gap）。
- `feature/` — 32 ファイル（主要機能を網羅）。
- `setup/` `test/` — 整備済（`test/` は本 PR で新設）。
- 残りの table / route doc は `server/db.ts` / `server/routes/*` から追補する
  （[`test/test-design.md`](test/test-design.md) の gap 参照）。

## 関連 issue
- #31 TS 化（この spec フォルダはその一部）
- #34 Local / Multi 二層化（multi 側の API 契約も将来 `interface/` に集約）
