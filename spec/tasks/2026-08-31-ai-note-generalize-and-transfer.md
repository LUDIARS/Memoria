---
task: ai-note-generalize-and-transfer
project: Memoria
kind: 運用
created: 2026-08-31
memory_links:
  - https://github.com/LUDIARS/Memoria/pull/1164
  - spec/feature/ai-hub.md
  - https://github.com/LUDIARS/Memoria/blob/76a4095ab998/server/ai-hub/notion-transfer-check.ts
  - https://github.com/LUDIARS/Memoria/blob/76a4095ab998/server/ai-hub/notion-transfer-disposition.ts
---

# 公開可能と再判定されたAIノートを汎用化してNotionへ転送する

## 目的

案件内容そのものではなく、案件を通じて得た汎用技術知見が価値の中心である記事だけを対象に、
案件名、個人環境、ローカルパス、環境設定などを公開可能な一般知識へ書き換え、安全性を再確認した
うえでNotionへ転送する。特に記事ID 7・18は、公開可能性を別途確認できる文脈または製品非依存の
説明へ置換できるかを本文単位で確認する。

## 作業内容

- 内容ベースの再分類taskで `generalization-required` と確定した記事だけを対象にする。
- 対象記事の固有案件名・顧客情報・内部構成・個人環境を伏字化または汎用化する。
- 元記事の技術的価値を維持しつつ、事実関係を変える置換や未検証の一般化を避ける。
- 書き換えた各記事へ同じNotion転送前チェッカーを再実行する。
- `transferable` になった記事だけをNotionへ転送し、重複作成を防ぐため転送結果を照合する。
- 再判定後も `blocked` または `generalization-required` の記事は転送せず、理由とタイトルは認可された
  ローカルの監査記録だけに残す。repository、共有ログ、Notionを含む外部サービスへは保存しない。
- ゲーム内容、設定、シナリオ、固有システム仕様そのものを一般論へ見せかけて転送しない。
- private repositoryのコード、設計、仕様、データ、アセットまたは挙動と直接対応する記事を転送しない。

## 完了条件

- 内容ベースの再分類taskで汎用化可能と確定した全記事に、転送、転送見送り、または既存Notion記事との
  重複という処理結果がある。
- Notionへ転送した全記事が、転送時点のチェッカーで `transferable` と判定されている。
- 案件名、秘密情報、個人環境、ローカルパス、R18内容が転送本文とタイトルに残っていない。
- 転送成功数、転送見送り数、見送り記事のタイトルと理由を集計して報告できる。
- 再実行しても同じ記事を重複転送しない。

## スコープ

- AIノートの汎用化対象本文・タイトル
- `server/ai-hub/` の既存チェッカーおよびNotion転送経路
- Notion上のAIノート転送先

## 非スコープ

- チェッカーを通らない原文の転送
- 案件固有情報を公開可能とみなすための判定基準緩和
- AIノートと無関係なNotionページの編集
- 記事140のようにゲーム内容そのものを扱う記事の汎用化・転送
- private repositoryのコンテンツと直接対応する記事の汎用化・転送
