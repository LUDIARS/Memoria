---
task: ai-note-content-confidentiality-reclassification
project: Memoria
kind: 実装
created: 2026-08-31
memory_links:
  - https://github.com/LUDIARS/Memoria/pull/1164
  - spec/feature/ai-hub.md
  - https://github.com/LUDIARS/Memoria/blob/76a4095ab998/server/ai-hub/notion-transfer-check.ts
  - https://github.com/LUDIARS/Memoria/blob/76a4095ab998/server/ai-hub/notion-transfer-disposition.ts
---

# AIノートを内容機密性で再分類する

## 目的

PR #1164 で `generalization-required` とされた76件を、単なる案件名・環境情報の除去可能性だけでなく、
記事の主題そのものがprivate repositoryのコンテンツ、案件固有のゲーム内容、実装または仕様を
開示していないかという観点で再分類する。案件を通じて得た汎用技術知見だけを汎用化候補に残し、
private repositoryのコンテンツと直接対応する記事は転送不可にする。

## 判定方針

- アルゴリズム、描画、運用手法、性能改善など、案件を伏せても独立して成立する技術知見は
  `generalization-required` にできる。
- ゲーム内容、世界設定、シナリオ、未公開機能、固有メカニクス、バランス設計、制作中アセット、
  案件固有システム仕様が記事価値の中心なら `blocked` とする。
- private repository内のコード、設計、仕様、データ、アセット、文言または挙動と直接対応する記事は、
  repository名や固有名詞を伏せても `blocked` とする。
- private repository由来でも、元コンテンツを復元・推測できず、独立した一般技術記事として成立するまで
  再構成できるものだけを `generalization-required` にできる。
- 固有名詞を伏せるだけで内容を推測できる記事や、一般論への置換で実質的に別記事になるものも
  `blocked` とする。
- 記事140および同種の記事は転送不可として扱う。
- 記事ID 7・18は、公開可能性を別途確認できる実例または案件非依存の技術説明として本当に成立する
  場合だけ `generalization-required` に残す。

## 作業内容

- 76件すべてのタイトルと本文を内容ベースで確認し、三分類をやり直す。
- 内容機密性の判定をチェッカーへ追加し、固有名詞検出だけに依存しないfail-closedな判定にする。
- source metadataとrepository visibilityを照合し、private repositoryのコンテンツへ直結する記事を
  自動転送対象へ入れない。
- 自動判定が難しい記事を安全側に倒し、人手確認理由を機械可読な形で出力する。
- 再分類後の件数と、`blocked` のタイトル一覧・理由を、認可されたローカルの確認先だけへ出力する。
  原文、タイトル、source metadataをrepository、共有ログ、外部サービスへ保存しない。

## 完了条件

- 228件すべてに、原文転送可、汎用化後に転送可、転送不可のいずれかが付いている。
- 記事140を含むゲーム内容そのものの記事が `blocked` になる。
- private repositoryのコンテンツと直接対応する記事が、伏字化の可否にかかわらず `blocked` になる。
- プロジェクト名を削除しただけでは公開可能にならない記事を、汎用化候補へ残していない。
- 記事ID 7・18の可否に、本文内容に基づく根拠がある。
- 三分類の各件数と、転送不可記事のタイトル一覧・理由を報告できる。

## スコープ

- `server/ai-hub/` のNotion転送前チェッカーと分類器
- AIノート全228件に対する読取専用の再集計
- `spec/feature/ai-hub.md`

## 非スコープ

- 再分類が終わる前の記事本文編集やNotion転送
- 案件内容を伏字だけで公開可能とみなす判定緩和
