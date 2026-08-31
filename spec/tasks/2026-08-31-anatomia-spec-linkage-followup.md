---
task: anatomia-spec-linkage-followup
project: Memoria
kind: 実装
created: 2026-08-31
memory_links:
  - https://github.com/LUDIARS/Memoria/pull/1136
  - spec/feature/ai-hub.md
  - https://github.com/LUDIARS/Memoria/blob/bb3fa389d695/server/ai-hub/notion-transfer-check.ts
---
# PR #1136 の Anatomia spec_linkage 未通過を解消する

## 目的

PR #1136 の非ブロック所見で報告された program layer の未分類 changed anchor 17 件を確認し、
AIノート Notion 転送前チェッカーと仕様の対応関係を明示して `spec_linkage` gate を通す。

## 完了条件

- マージコミット `bb3fa389d695` を対象に、未分類とされた17件の anchor を特定できる。
- 各 anchor を既存仕様へ紐付けるか、仕様追加または明示的な除外が必要な理由を個別に判断できる。
- blanket ignore や無関係な wrapper を追加せず、Anatomia の `spec_linkage` gate が通る。
- チェッカーの判定契約やCLI出力を変更する場合、関連する AI Hub 仕様も同じ変更単位で更新される。

## スコープ (編集可ディレクトリ)

- `server/ai-hub/`
- `server/scripts/`
- `server/shared/`
- `spec/feature/`
- `spec/interface/`
- `spec/domains/`
