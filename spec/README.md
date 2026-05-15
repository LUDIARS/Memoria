# `spec/` — Memoria 仕様書

このフォルダは Memoria のローカルサーバの **データモデル / API 契約** を
人間が読める形 (Markdown) で集約する場所。 TypeScript の型定義 (`server/db/types/`,
`server/api/types/`) と一対一で対応する。

## 構成

```
spec/
├── db/         ← SQLite テーブル定義 (列・index・制約)
├── api/        ← HTTP API 契約 (request / response)
└── feature/    ← 機能仕様 (シェア可能性 + プライバシー注記付き)
```

## ルール

- **正本は spec**。 実装の TS 型はここから生やす。
- **どちらも対応する .md / .ts を 1 セットで変更**する。 spec だけ書いて型を更新しない、
  あるいは型だけ変えて spec を更新しないのは禁止 (PR で reviewer が指摘)。
- **段階移行中**: 既存の `server/db.ts` の CREATE TABLE は引き続き正本。 spec/db/ は
  そこから型化を進める出発点。 Phase 後半で実装側を spec から再生成する形に倒す。

## 関連 issue
- #31 TS 化 (この spec フォルダはその一部)
- #34 Local / Multi 二層化 (multi 側の API 契約も将来 spec/api/ に集約)
