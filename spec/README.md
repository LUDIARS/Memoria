# Memoria Spec

リファクタした機能 (server/diary/, server/db/, server/routes/) の仕様書。
**実行可能仕様 (Executable Specs)** として `server/test/<module>.test.js` を参照する。

## 構造

```
spec/
├── README.md          # このファイル
├── architecture.md    # 全体構造 + リファクタ後のレイヤー図
├── diary/
│   ├── date.md        # 日付ユーティリティ
│   ├── gps.md         # GPS 集計 + Haversine
│   ├── nutrition.md   # BMR / TDEE / カロリーバランス
│   ├── github.md      # GitHub API 統合
│   ├── prompt.md      # LLM プロンプト組み立て
│   ├── generate.md    # LLM 呼び出し (work_content / highlights / weekly)
│   └── aggregate.md   # 1 日分メトリクス集計
└── db/
    ├── _helpers.md    # 共通ユーティリティ
    ├── bookmarks.md   # ブックマーク CRUD + ページング
    ├── meals.md       # 食事記録 CRUD
    ├── dig.md         # ディグセッション CRUD
    ├── visits.md      # アクセス履歴 + suggested visits
    └── ...            # 他 domain は段階的に追加
```

## 仕様の書式

各モジュールの spec は以下を記載:

1. **目的** — 何をするモジュールか (1-2 文)
2. **公開関数** — シグネチャ + 説明
3. **不変条件 / 制約** — 入力値の前提、 副作用、 例外
4. **テスト** — `server/test/<module>.test.js` への参照
5. **既知の制限** — 設計上の妥協点 / 将来の改善案

## 関連ドキュメント

- `docs/review/2026-05-01-aiformat-server-review.md` — リファクタの動機 (D 評価の解消)
- `docs/multi-server-architecture.md` — Local/Multi 二層化計画 (#34)
- `server/db/README.md` — DB アダプタ層の説明
