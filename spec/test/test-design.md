# テスト設計

方針は AIFormat [`RULE_TEST.md`](https://github.com/LUDIARS/AIFormat/blob/main/RULE_TEST.md)。
Memoria は **ローカルアプリ（ライフログ + ナレッジハブ）** 種別。重視点は
ローカル SQLite の整合・破損耐性、プライバシー境界（個人データはローカルに閉じる /
共有は明示 opt-in）、主要フローの smoke。

## 現状
- CI（[`../../.github/workflows/ci.yml`](../../.github/workflows/ci.yml)）は
  **lint + typecheck + smoke** まで:
  - `node --check`（server / mcp-server / extension の JS 構文）
  - `npx tsc --noEmit`（server typecheck）
  - `eslint --max-warnings 0`（server TS）
  - frontend build（esbuild）
  - extension manifest 検証（MV3）
  - **smoke**: mock claude CLI を置き、server を起動 → `/api/bookmarks` 等 GET +
    bookmark POST → queue drain → 保存確認。
- desktop は `desktop-publish.yml`（タグ起動）+ ci.yml の desktop ジョブで
  typecheck + build:ts。
- **専用の unit / integration テストフレームワークは未導入（gap）**。

## 種別ごとの観点（充実とみなす対象 / やること）

### ビルド / lint / typecheck（実施済）
- server / frontend / desktop / mcp-server / extension の構文・型・lint。

### smoke（実施済）
- server boot + bookmark 1 件の保存フロー（mock claude）。

### ユニット（未導入、やること）
- [ ] テストフレームワーク（vitest）導入。
- [ ] `server/db/` の per-domain repository（CRUD・SQLite migration の整合）。
- [ ] Lector パーサ / 要約 / dig 等の純ロジック（外部 API はモック）。
- [ ] プライバシー注記（feature の シェア可能性マーカー）に沿った
      共有/非共有の境界（個人データがローカルに閉じること）。

### 統合（未導入、やること）
- [ ] 主要 API（bookmark / note / diary / task）の REST 経路。
- [ ] Hub presence / multi（Corpus 連携）の `module_request` 経路。
- [ ] push 通知トリガの batch 化（日記/Dig 即時、ブクマ要約 5件 or 5分）。

> Memoria はモノリシックで unit 分離が難しい面がある。優先度は
> 「smoke の拡張（主要フロー）→ repository unit → 統合」の順。
