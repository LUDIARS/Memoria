# data: 成長型ブラックボックス (blackbox_rules / blackbox_decisions)

汎用ルールエンジンの永続化。 ドメイン非依存 (天気 / 将来のゲーム等が共用)。
実装は `server/blackbox/store.ts`。 設計は spec/feature/blackbox.md。

## blackbox_rules

「条件 (when) が成立したら output を返す」 ルール 1 件 = 1 行。

| column | type | 説明 |
|--------|------|------|
| id | TEXT PK | randomUUID |
| domain | TEXT | `weather.will_rain` / `weather.likely_place` / `game.*` |
| description | TEXT | 人間可読のルール説明 |
| when_json | TEXT | 直列化された Condition AST (`{op,...}`) |
| output_json | TEXT | 条件成立時の判断結果 (JSON) |
| confidence | REAL | 0..1 |
| enabled | INTEGER | 1=有効。 LLM 提案ルールは 0 で起票され人間が有効化 |
| source | TEXT | `llm` / `manual` / `seed` |
| approvals | INTEGER | 人間 OK の累計。 3 で auto 化 (LLM を呼ばなくなる) |
| rejections | INTEGER | 人間 NG の累計。 3 で enabled=0 (ルール撤回) |
| priority | INTEGER | 同 domain 内の適用順 (降順) |
| created_at / updated_at | TEXT | ISO |

INDEX: `(domain, enabled, priority DESC)`。

## blackbox_decisions (ledger)

全判断の記録。 `status='pending_review' AND verdict IS NULL` がレビュー待ちキュー。

| column | type | 説明 |
|--------|------|------|
| id | INTEGER PK | |
| domain | TEXT | |
| input_json | TEXT | 判断の生入力 (再現・採掘用) |
| features_json | TEXT | 抽出した FeatureMap (ルールが見る値) |
| output_json | TEXT | 判断結果 |
| source | TEXT | `rule` / `llm` |
| rule_id | TEXT | rule 由来ならその id |
| confidence | REAL | |
| rationale | TEXT | なぜそう判断したか |
| status | TEXT | `auto` / `pending_review` |
| verdict | TEXT | `ok` / `ng` / NULL (未レビュー) |
| created_at / reviewed_at | TEXT | ISO |

INDEX: `(status, verdict, created_at DESC)` / `(domain, created_at DESC)`。

## 成長の流れ (要約)

LLM 判断 (ledger 蓄積) → LLM が Condition 候補を提案 (enabled=0) → 人間が有効化 →
ルールが先に判断 (pending_review で OK/NG 募集) → approvals 3 到達で auto (LLM 不要) →
予報外れが続けば rejections 3 で撤回 → LLM に差し戻し。
