# 成長型ブラックボックス (Growth Black Box) — 汎用ルールエンジン

`server/blackbox/` ドメイン。 **ドメイン非依存** の判断エンジン。 最初は LLM が下した
判断を記録し、 「論理的に判断可能」 な事象をルール (アルゴリズム) に昇格させ、 徐々に
LLM 無しで動くようにする。 天気はこのエンジンの最初の適用例。 ゲーム (敵 AI / ドロップ
抽選 / イベント分岐) にも転用できるよう、 Memoria 固有の型・DB に一切依存しない。

> 「成長型」 = はじめ全部 LLM (ブラックボックス) → 観察された判断を人間が OK/NG →
> 安定した判断はルール化 → 最終的に中身が透明な決定木 (ホワイトボックス) に近づく。

## 0. 切り出し境界

`server/blackbox/` 配下は Memoria 固有 path / schema に直結しない。 永続化は
`RuleStore` / `DecisionLedger` interface 越し (DB 実装は `store.ts` に隔離)。 LLM 呼び出しは
`LlmFallback` 関数注入。 → `mv server/blackbox/ ../blackbox/` で他サービス・ゲームに移植可能。

## 1. 中核概念

### Feature (特徴量)
判断の入力を **フラットな数値/文字列/真偽の map** に落としたもの。
`FeatureMap = Record<string, number | string | boolean>`。 ルールはこの map のみを見る
(生の入力オブジェクトは見ない) ので、 ルールは純粋・直列化可能になる。

例 (weather.will_rain): `{ agreement: 0.85, maxPop: 70, maxPrecipMm: 3.2, month: 6 }`。

### Condition (直列化可能な述語 AST)
ルールの条件は **JSON で表現される式木**。 コードではなくデータなので DB に保存でき、
LLM が新ルールを「データとして」 出力できる。

```ts
type Condition =
  | { op: 'cmp'; feature: string; cmp: '>'|'>='|'<'|'<='|'=='|'!='; value: number|string|boolean }
  | { op: 'in';  feature: string; values: (string|number)[] }
  | { op: 'and'; clauses: Condition[] }
  | { op: 'or';  clauses: Condition[] }
  | { op: 'not'; clause: Condition }
```

`evaluate(cond, features): boolean`。 未知 feature の cmp は false。

### Rule
```ts
interface Rule {
  id: string;
  domain: string;            // 'weather.will_rain' | 'game.enemy.aggro' ...
  description: string;       // 人間可読の意味
  when: Condition;           // 直列化された述語
  output: unknown;           // 条件成立時の判断結果 (JSON)
  confidence: number;        // 0..1
  enabled: boolean;
  source: 'llm' | 'manual' | 'seed';
  approvals: number;         // 人間が OK した回数 (信頼の蓄積)
  rejections: number;        // NG にした回数
  priority: number;          // 同 domain 内の適用順 (大きいほど先)
}
```

### Decision (判断の結果 + 来歴)
```ts
interface Decision {
  output: unknown;
  source: 'rule' | 'llm';
  ruleId?: string;
  confidence: number;
  rationale: string;                       // なぜそう判断したか
  status: 'auto' | 'pending_review';       // ルール由来で未承認なら pending
}
```

## 2. エンジンのアルゴリズム (`engine.ts`)

`decide(domain, features, rawInput, llmFallback): Decision`:

1. `domain` の **enabled ルール** を priority 降順で評価し、 最初に `when` が成立した
   ルールを採用候補にする。
2. ルールがヒットした場合:
   - `approvals >= AUTO_PROMOTE_THRESHOLD` (既定 3) → `status: 'auto'`。 LLM を呼ばない。
   - まだ未承認 → `status: 'pending_review'`。 **アルゴリズムで先に判断できた旨を出力に
     載せ、 人間の OK/NG を待つ** (= 仕様の要件)。 この間も output 自体はルール結果を返す。
3. ルールがヒットしない (または該当 domain にルールが無い) 場合:
   - `llmFallback(rawInput)` を呼び LLM に判断させる → `source: 'llm'`。
   - LLM が「この判断はルール化可能」 と判断したら、 同時に `Condition` 形式の
     ルール候補を返せる (`proposeRule`)。 候補は `enabled: false` でストアに登録され、
     人間 OK で有効化される。
4. すべての判断を `DecisionLedger` に記録 (input/features/output/source/rule_id/status)。
   これが後からのルール採掘 (rule mining) と精度検証の材料。

`recordVerdict(decisionId, 'ok'|'ng')`:
- ルール由来の pending 判断に人間が OK → 当該ルールの `approvals++`。 閾値到達で `auto` 化
  (以後 LLM 無し)。
- NG → `rejections++`。 一定回数で `enabled=false` (ルール撤回) し LLM に差し戻す。
- LLM 由来の判断への OK は「この LLM 判断は妥当」 の教師ラベルとして ledger に残る
  (将来のルール採掘の正例)。

## 3. 成長フロー (LLM → ルール)

```
[1] 新規 domain: ルール 0 件 → 全部 LLM が判断 (ledger に蓄積)
[2] LLM が安定した判断を Condition 候補として提案 (or 人間/採掘がルール起票)
[3] ルールは enabled=false で pending。 人間が UI で内容確認して有効化
[4] 有効化後はルールが先に判断するが status=pending_review で OK/NG を募る
[5] approvals が閾値到達 → status=auto。 LLM を呼ばなくなる (= 中身が透明化)
[6] 予報が外れ続けたら NG が溜まりルール撤回 → LLM に戻る (自己修復)
```

最終的に LLM 依存ゼロでも回る = 「LLM サポートなく動かせる」 要件を満たす。

## 4. 永続化 (Memoria 束縛 `store.ts`)

- `blackbox_rules` テーブル: ルール本体 (when は JSON 文字列)。
- `blackbox_decisions` テーブル: ledger。 pending_review 行が UI のレビュー待ちキュー。
- 詳細スキーマは spec/data/blackbox.md。

## 5. API (`routes/blackbox.ts`)

| method | path | 説明 |
|--------|------|------|
| GET | `/api/blackbox/decisions?status=pending_review` | レビュー待ち判断 |
| POST | `/api/blackbox/decisions/:id/verdict` | `{verdict:'ok'\|'ng'}` で承認/却下 |
| GET | `/api/blackbox/rules?domain=` | ルール一覧 |
| POST | `/api/blackbox/rules/:id/toggle` | 有効/無効 |
| POST | `/api/blackbox/rules` | 手動ルール追加 (Condition を JSON で) |

## 6. ゲーム転用の想定

- `domain='game.enemy.aggro'`, features=`{playerDist, playerHpPct, alliesNearby}` →
  「追尾するか」 を最初は LLM (バランス調整 AI)、 安定したら `dist<5 && hpPct>0.3` ルール化。
- エンジン (`engine.ts` / `condition.ts` / `types.ts`) は Memoria を一切 import しない。
  ゲーム側は自前の `RuleStore` 実装 (オンメモリ or 別 DB) を差すだけ。

## 関連

- [天気マルチソース](weather-multisource.md) — 最初の適用ドメイン
- 既存 `llm.ts` (`runLlm`) を `LlmFallback` として注入
- spec/data/blackbox.md (テーブル定義)
