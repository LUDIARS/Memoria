# AIノート Notion 転送前チェッカーが案件機密を見逃す

- Date: 2026-08-31
- Status: fixed in working tree
- Area: AI Hub / Notion transfer safety
- Severity: external disclosure risk

## Summary

Notion 転送前チェッカーは秘密値・個人識別子・R18表現を検査していたが、案件由来であることと、
環境変数・個人環境の構成に関する言及を十分に判定していなかった。外部の教育機関向け Notion へ
案件情報または個人環境情報を転送し得る回帰である。

## Evidence

- 2026-08-31、ユーザーから MakaiNui・Ludellus 等の案件記事が転送可能側に残ると報告された。
- `server/shared/sensitive-content.ts` の built-in 規則は秘密鍵、token、メールアドレス、特定の
  user/workspace path に限定されていた。
- `server/ai-hub/notion-transfer-check.ts` は `ai_articles.source_refs` を読み込まず、記事の由来を
  判定できなかった。
- 228記事の読み取り専用調査で、案件機密28件、秘密・個人環境情報51件を検出し、重複を除く
  転送不可77件を確認した。R18該当は0件だった。

## Regression Context

初版チェッカーは文字列として露出した秘密情報の検出を中心に実装され、記事 provenance と
案件区分を転送可否契約へ含めていなかった。初回集計が転送可能221件と過大になった。

## Cause

転送対象を title/body だけに縮約したため、構造化済みの `source_refs.repo` を安全判定へ利用して
いなかった。また個人環境の検査が Windows user/workspace path の一部に限定されていた。

## Fix Requirements

- MakaiNui、Ludellus 系、KuzuSurvivors/KS、PrivateGame、SUPERFAT の provenance または本文言及を遮断する。
- malformed または構造不正な `source_refs` は fail-closed で遮断する。
- 環境変数、任意の絶対ローカルパス、loopback endpoint、個人環境への明示的言及を遮断する。
- 出力へ禁止語、一致本文、案件名そのものを理由として露出しない。
- 全記事を再集計し、転送可否件数と転送不可タイトルを更新する。

## Verification

- ユーザー指示により単体・統合テストは実行しない。
- 登録済みの回帰テストに、案件 provenance、本文別名、malformed および構造不正の
  provenance、環境変数構文、絶対パス、IPv4/IPv6 loopback endpoint、個人環境文脈の
  各 fixture を追加した。
- 実データに対する読み取り専用チェッカー実行で、全228件、転送可151件、転送不可77件を確認した。

## Follow-up

案件プロジェクトが増えた場合は、外部転送を始める前に制限リストへ登録する。
