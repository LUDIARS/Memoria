---
task: ai-note-generalization-anatomia-followup
project: Memoria
kind: 実装
created: 2026-08-31
memory_links:
  - https://github.com/LUDIARS/Memoria/pull/1164
  - spec/feature/ai-hub.md
  - https://github.com/LUDIARS/Memoria/blob/76a4095ab998/server/ai-hub/notion-transfer-disposition.ts
---

# PR #1164 の Anatomia未分類anchorとspec_linkage失敗を解消する

## 目的

PR #1164 の非ブロック所見で報告されたprogram layerの未分類changed anchor 19件を特定し、
AIノートの汎用化判定仕様との対応関係を明示して `spec_linkage` gateを通す。

## 作業内容

- マージコミット `76a4095ab998` を対象に、未分類とされた19件のanchorを特定する。
- 各anchorを既存のAIノートNotion転送安全仕様へ紐付ける。
- 既存仕様で表現できない場合だけ、必要最小限の仕様またはdomain定義を追加する。
- PR #1164向けの既存追跡taskと対応内容を照合し、重複するリンク修正を増やさない。

## 完了条件

- 未分類19件の各anchorについて、所属仕様または正当な除外理由が機械判定可能になっている。
- `spec_linkage` gateが通る。
- blanket ignoreや無関係なwrapperを追加していない。
- 仕様リンク修正によって、三分類の判定契約や集計結果が変化していない。

## スコープ

- `server/ai-hub/`
- `server/scripts/`
- `server/shared/`
- `spec/feature/`
- `spec/interface/`
- `spec/domains/`

## 非スコープ

- 汎用化判定基準の緩和
- AIノート本文の書き直しやNotion転送
- Anatomiaの警告を一括抑止する設定変更
