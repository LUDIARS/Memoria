---
task: memoria-llm-usage-cost-accuracy
project: Mm
kind: implementation
created: 2026-09-29
actio_reference: actio:e3a49119-4244-43ec-b712-afc9c859ccf5
memory_links: []
---

# LLM 観測所の使用量・コスト計算を正確にする

neco の依頼（Actio 参照）: Memoria の LLM 使用量・コスト計算を修正する。

設計は `spec/feature/llm-observatory.md`（データ / 応答の重複除去と帰属 / 指標 / API）を正本とする。

分解:
1. 料金表: 公式単価（Claude / OpenAI）を完全一致 ID で引き、cache 倍率をモデル別に持つ。
   未掲載モデルは未評価（NULL）にし、Codex credits は別単位で出す。料金表に版を付ける。
2. ログ解析: Claude の stream 断片を `message.id` で最終 usage に畳む。サブエージェントは親 family へ帰属させ、
   TTL 不明の cache write と effort / perTurnEffort を保つ。Codex は `archived_sessions` も読む。
3. 保存: 応答単位の `llm_usage_responses` へ upsert し、コピー履歴や archive、同じ sync の再実行を重複排除する。
   parser 版で既存 source を読み直し、料金版で保存済み応答を再計算する。旧 `llm_usage_records` は削除しない。
4. 表示: 選択期間（JST）の全応答を SQL 集計し、入力 / cache / 出力のトークンとコストの内訳、
   未評価件数、Codex credits を示す。セッション一覧の 500 件上限は合計に影響させない。

完了条件（契約: リポジトリ直下の `augur.contracts.json`）:
- C-1 estimateResponseCost(provider, model, usage): 未掲載モデルは usd・breakdown が null、掲載モデルは usd が内訳の合計に一致する
- C-2 mergeResponse(existing, incoming): 各トークン項目は両者の最大値で、合算しない。元ファイル側の帰属を優先する
- C-3 claudeTokens(usage): cache write の 5m + 1h + 不明の合計は `max(cache_creation_input_tokens, 5m + 1h)` に一致する
- C-4 repriceStaleResponses(db): 実行後、現行料金版でない応答行が 0 になる
- C-5 parseUsagePeriod(from, to, nowMs): YYYY-MM-DD の from ≤ to を返す
- C-6 usageDashboard(db, period, nowMs): 期間合計の応答数・コストがモデル別行の合計に一致する

回帰テスト: `server/llm-usage/price-table.test.ts`、`log-parsers.test.ts`、`response-store.test.ts`、`usage.test.ts`。

実施記録（2026-09-29）:
- 公式料金 3 ページを実装時に確認した（Opus 5.5 は $4 / $20、5m 書込 $5、1h 書込 $8、read $0.20。GPT-6 Astra / Sol と
  GPT-5.6 は OpenAI 公式単価あり。gpt-5-codex と auto-review は現行ページに無いため未評価）。
- native ログ本体は個人データを含むため読んでいない。ログのフィールド名（Claude の `effort` / `perTurnEffort`、
  Codex の `reasoning_effort`）はコードと既存テストを根拠にした前提で、実ログでは未確認。
- 監査値（2026-09-22〜09-28 JST の Opus 11,064 応答、暫定 $1,735.61）は、`GET /api/llm-usage?from=2026-09-22&to=2026-09-28`
  の `period.by_model` と照合できる形にしたが、同期を実行していないため照合は未実施。
- テスト・型検査・同期・起動は実行していない（許可なし）。

契約検証の準備（2026-09-30）:
- 公開済み `@ludiars/log-weaver@0.1.0` には `contract` export が無い（Lapilli 側の `contract()` は未公開）。
  そのため `augur.contracts.json#importFrom` は `server/shared/contract-runtime.ts`（`../shared/contract-runtime.js`）を指す。
  weaver と同じ 3 種のメッセージと ctx キーを `contracts.jsonl` に書く。`LOG_WEAVER=1` のときだけ述語を評価する
  （sync は解析関数を 1 行ごとに呼ぶため、既定では素通し）。
- `augur.inject.json` は `contract-wrap` だけを有効にし、`server/llm-usage` の本体コードに限定する。
- C-4 の述語は「版が 1 種類以下」ではなく「現行 `PRICE_TABLE_VERSION` 以外の行が 0」を検証する（全件旧版でも通っていた穴を塞いだ）。
  C-2 の述語は帰属に `familyId` も含める。
- 注入は証跡取得時だけ行う（apply → `LOG_WEAVER=1` で回帰テスト → `augur contracts report` → remove）。
  注入後の述語 import は `.ts` 拡張子になるため、注入状態のままでは `tsc --noEmit` が TS5097 を出す。注入はコミットしない。

契約検証の実行記録（2026-09-30、neco の明示承認「検証を実行」による。worktree の単体テストのみ。サービス起動・本番 DB 再計算はしていない）:
- 対象 head: e92e7c2（注入はこの commit に対して行い、解除後に HEAD とバイト一致を確認）。Cc testing claim #1585 を登録し、実行後に release した。
- 実行: `LOG_WEAVER=1` で `price-table` / `log-parsers` / `response-store` / `usage` の 4 テスト → 31 件 pass / 0 fail。
- `augur contracts report --since 2026-09-30T00:05:51Z`: covered=6 violated=0 uncovered=0、events=586 matched=586 foreign=0 undated=0。
  C-1 537 回 / C-2 6 回 / C-3 17 回 / C-4 4 回 / C-5 11 回 / C-6 11 回、いずれも違反 0（最終観測 2026-09-30T00:05:56Z）。
- 証跡ファイル（gitignore 対象のローカルのみ）: `server/logs/contracts-evidence/contracts.jsonl`・`report.json`・`acceptance.json`。
- 追加した回帰テスト: `server/shared/contract-runtime.test.ts`（observed、false / string の違反、pre 違反時は observed を出さない、
  述語の throw、`LOG_WEAVER` が `1` 以外なら述語を評価しない、本体の戻り値・throw・reject・`this` を保つ）と
  `server/llm-usage/reprice-contract.test.ts`（C-4: 全件旧版・混在・不正件数を拒否し、再計算後は受理）。
  変更前の C-4 述語は全件旧版の表を `true` で通し、新しい述語は拒否することを個別に確認した。
- 追加後の 6 テストは 43 件 pass。lint（変更ファイル）は 0 件。typecheck のエラー 19 件は、すべて未初期化のサブモジュール
  `server/plugins/memoria-plugin` に由来する既存のもので、今回の変更に起因するものは 0 件。
