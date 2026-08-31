---
task: ai-note-anatomia-followup
project: Memoria
kind: 実装
created: 2026-08-31
memory_links:
  - https://github.com/LUDIARS/Memoria/pull/1154
  - spec/feature/ai-hub.md
  - https://github.com/LUDIARS/Memoria/blob/d87a26e85ee9/server/ai-hub/notion-transfer-check.ts
  - https://github.com/LUDIARS/Memoria/blob/d87a26e85ee9/server/ai-hub/project-confidentiality.ts
---

# PR #1154 の Anatomia 未分類 anchor と orphaned function を解消する

## 目的

PR #1154 の非ブロック所見で報告された program layer の未分類 changed anchor 18件と
orphaned function 1件を特定し、AIノート Notion 転送安全仕様との対応関係を明示する。

## 完了条件

- マージコミット `d87a26e85ee9` を対象に、未分類とされた18件の anchor と orphaned function
  1件を特定できる。
- 各 anchor を `SPEC-AI-NOTION-TRANSFER-SAFETY` または適切な既存仕様へ紐付け、既存仕様で
  表現できない場合は必要最小限の仕様を追加する。
- orphaned function を適切な program domain へ所属させるか、除外が正当な場合はその理由を
  機械判定可能な形で明示する。
- blanket ignore や無関係な wrapper を追加せず、Anatomia の該当 gate が通る。
- 仕様リンク修正によってチェッカーの判定契約と集計結果を意図せず変更しない。

## スコープ (編集可ディレクトリ)

- `server/ai-hub/`
- `server/scripts/`
- `server/shared/`
- `spec/feature/`
- `spec/interface/`
- `spec/domains/`
