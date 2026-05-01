# 決定: Server TS 化の方針

| 項目 | 値 |
|---|---|
| 提案日 | 2026-05-01 |
| ステータス | **Accepted (段階移行)** |
| 関連 | `docs/review/2026-05-01-aiformat-server-review.md` (§1.2 / §6) |
| 関連 | LUDIARS `RULE_TECH_STACK.md` (TS + Hono + Drizzle) |

## 背景

- AIFormat レビューで「設計思想の一貫性」が **C** 評価。 LUDIARS 標準
  (TypeScript / Drizzle / Vite) から逸脱
- リファクタ (PR `refactor/server-modularization`) で God Object 3 つを
  分割完了 — domain 別に小さい module になった
- Vitest で 45 テスト追加、 純関数 / DB 層の挙動を pin
- 仕様書を `spec/` に整備、 移行時のリファレンスができた

これで TS 化の前提条件 (テスト + 分割 + 仕様) がそろったので、 改めて
方針を確定する。

## 制約

| 環境 | Node version | TS native 対応 |
|---|---|---|
| 開発機 (Win/macOS/Linux) | 22+ / 24 推奨 | あり (22.6+ で `--experimental-strip-types`、 23.6+ default) |
| CI (`.github/workflows/ci.yml`) | **Node 20** | **無し** |
| Desktop 同梱 (electron-builder) | Node 22.11 portable | あり (フラグ要) |
| MCP server | Node 22+ | あり |

CI が Node 20 (LTS) を使い続ける限り、 native TS は CI で動かない。

## 候補

### (a) tsx ランタイム化

| 軸 | 評価 |
|---|---|
| 実装コスト | 中 (server/devDeps + scripts + bundle-server.ts 修正) |
| 実行コスト | tsx は ~10MB、 起動 +200ms 程度 |
| Desktop 影響 | bundle-server.ts に tsx 同梱が必要 |
| CI 影響 | `npm ci` で tsx を install すれば動く |
| 将来 | LUDIARS 他サービス (Custos など) で実績あり |

**メリット**: import の `.ts` 拡張子問題を tsx が吸収。 漸進的 migration が
やりやすい (.js と .ts 共存可)。

**デメリット**: production も tsx を介する → 起動時の overhead と依存追加。

### (b) tsc build step (.ts → dist/.js)

| 軸 | 評価 |
|---|---|
| 実装コスト | 高 (tsconfig.build.json + dist/ + scripts + bundle-server) |
| 実行コスト | ゼロ (compiled JS を node が直接実行) |
| Desktop 影響 | bundle-server.ts が dist/ をコピーする形に変更 |
| CI 影響 | build → test → smoke の段階追加 |
| 将来 | 本番性能を最重視するなら |

**メリット**: ランタイム overhead ゼロ、 prod に余分な依存なし。

**デメリット**: build step が増えるので dev フィードバックが遅い (tsx watch なら不要だが、 build 経路に行くと変化を逐次確認しづらい)。

### (c) JSDoc + `// @ts-check` (現状維持 + 型強化)

| 軸 | 評価 |
|---|---|
| 実装コスト | 低 (tsconfig 維持、 .js のまま、 ファイルごとに `// @ts-check`) |
| 実行コスト | ゼロ |
| Desktop 影響 | 無し |
| CI 影響 | 無し |
| 将来 | LUDIARS 標準 (.ts) に揃わない |

**メリット**: ランタイム / インフラに 1 行も触れずに型安全性が得られる。

**デメリット**: LUDIARS 標準スタックから外れる。 Drizzle 化 / Vite 化への
入口にならない。

### (d) Node 20 卒業を待ってから native TS

| 軸 | 評価 |
|---|---|
| 実装コスト | ほぼゼロ (待つだけ) |
| 時期 | Node 20 EOL = 2026-04 (LTS), CI を 22+ に上げれば即可能 |

**メリット**: 追加依存ゼロ、 単純に node で `.ts` を実行できる。

**デメリット**: 待つ時間がある。 CI を 22 に上げれば今すぐ可能。

## 決定

**(a) tsx + (d) CI 22 化** のハイブリッドで段階移行する。

### 段階

1. **このセッション (実施済)**
   - リファクタで domain 別に分割
   - Vitest 45 件で挙動 pin
   - spec/ で仕様書化
   - 本決定文書

2. **次フェーズ (PR `chore/server-node-22-and-tsx`)**
   - CI を Node 22 に上げる (`actions/setup-node@v4` の `node-version: '22'`)
   - server/devDeps に tsx 追加
   - `npm run dev` を `tsx watch index.js` に変更 (`.js` のまま OK)
   - `npm start` は `node index.js` のまま (本番は依然 .js)
   - Desktop bundle-server.ts は無変更 (dist/ 不要、 server/ そのまま同梱)

3. **次々フェーズ (PR `feat/server-ts-leaf`)**
   - 純関数 module (`diary/date.ts` `diary/gps.ts` `diary/nutrition.ts`
     `db/_helpers.ts`) を `.ts` に rename + 型注釈
   - tsconfig は `noEmit: true` のまま (型チェックのみ)
   - tsx が `.ts` を解決
   - import path: `from './date.js'` → `from './date.ts'` (ESM の慣習に
     合わせて拡張子付き)
   - 影響範囲: 純関数のみ、 既存テスト 45 件で挙動を guard

4. **以降 (1 module ずつ別 PR)**
   - `db/<domain>.ts` 化 (Drizzle ORM 導入と同時 or 直前)
   - `routes/<group>.ts` 化 (Zod スキーマ導入と同時)
   - `index.ts` (最後、 多くの依存が TS 化されてから)

5. **Drizzle ORM 導入** (別 PR)
   - sqlite ドライバで現行 SQL と互換取りつつ移行
   - `db/schema.ts` (Drizzle pgTable 風 sqliteTable)

### 採用しない選択肢の理由

- **(b) tsc build**: production overhead はない代わりに dev / Desktop bundle の構成変更が広範囲に及ぶ。 tsx の overhead は許容範囲なので、 build step は導入しない
- **(c) JSDoc only**: LUDIARS 標準を満たさない。 移行ゴールが見えなくなる

## 完了条件

- [ ] CI が Node 22 で動く
- [ ] `npm run dev` が tsx watch
- [ ] 全 module が `.ts`、 named export に型注釈あり
- [ ] tsconfig が `strict: true, checkJs: false` (純 TS のみ)
- [ ] Drizzle ORM で DB layer 統合
- [ ] Zod が API I/O に導入
- [ ] テストカバレッジ 60% 以上 (現状 ~10%)

## 参考

- `RULE_TECH_STACK.md` のサーバスタック (Hono + Drizzle + TS + Zod)
- 他 LUDIARS サービス (Custos / Curare 等) の TS 実装
