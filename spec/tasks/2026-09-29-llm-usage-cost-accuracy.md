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
