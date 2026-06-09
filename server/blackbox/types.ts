// 成長型ブラックボックス — ドメイン非依存の中核型。
//
// このファイルは Memoria 固有の型 / DB / LLM を一切 import しない。
// `server/blackbox/` 配下はそのまま他サービス・ゲームへ移植できる境界に保つ
// (spec/feature/blackbox.md §0)。

/** 判断の入力をフラット化した特徴量。 ルールはこの map だけを見る。 */
export type FeatureValue = number | string | boolean;
export type FeatureMap = Record<string, FeatureValue>;

/** 直列化可能な述語 AST。 コードでなくデータなので DB 保存・LLM 生成が可能。 */
export type Condition =
  | { op: 'cmp'; feature: string; cmp: CmpOp; value: FeatureValue }
  | { op: 'in'; feature: string; values: Array<string | number> }
  | { op: 'and'; clauses: Condition[] }
  | { op: 'or'; clauses: Condition[] }
  | { op: 'not'; clause: Condition };

export type CmpOp = '>' | '>=' | '<' | '<=' | '==' | '!=';

/** ルール = 「条件が成立したらこの output を返す」 を表すデータ。 */
export interface Rule {
  id: string;
  domain: string;
  description: string;
  when: Condition;
  /** 条件成立時の判断結果 (JSON 直列化可能な任意値)。 */
  output: unknown;
  confidence: number;          // 0..1
  enabled: boolean;
  source: 'llm' | 'manual' | 'seed';
  approvals: number;           // 人間が OK した回数 (信頼の蓄積)
  rejections: number;          // NG にした回数
  priority: number;            // 同 domain 内の適用順 (大きいほど先)
  createdAt: string;
  updatedAt: string;
}

/** ルールを作るための入力 (id / 監査列はストアが補完)。 */
export interface RuleDraft {
  domain: string;
  description: string;
  when: Condition;
  output: unknown;
  confidence?: number;
  enabled?: boolean;
  source?: Rule['source'];
  priority?: number;
}

/** 判断の結果 + 来歴。 */
export interface Decision<O = unknown> {
  output: O;
  source: 'rule' | 'llm';
  ruleId?: string;
  confidence: number;
  rationale: string;
  /** ルール由来で未承認なら pending_review = 人間の OK/NG 待ち。 */
  status: 'auto' | 'pending_review';
}

/** ledger に残る 1 判断のレコード (永続化された Decision + 入力)。 */
export interface DecisionRecord {
  id: number;
  domain: string;
  input: unknown;
  features: FeatureMap;
  output: unknown;
  source: 'rule' | 'llm';
  ruleId: string | null;
  confidence: number;
  rationale: string;
  status: 'auto' | 'pending_review';
  verdict: 'ok' | 'ng' | null;
  createdAt: string;
  reviewedAt: string | null;
}

/**
 * LLM フォールバックの戻り値。 LLM は判断結果に加えて、
 * 「この判断はルール化可能」 なら Condition 形式のルール候補を返せる。
 */
export interface LlmJudgement<O = unknown> {
  output: O;
  confidence: number;
  rationale: string;
  /** ルール化可能なら候補を返す。 enabled:false で登録され人間 OK で有効化。 */
  proposedRule?: Omit<RuleDraft, 'domain'>;
}

/** raw 入力から LLM 判断を得る関数 (Memoria 側で runLlm を束ねて注入)。 */
export type LlmFallback<I = unknown, O = unknown> = (input: I, features: FeatureMap) => Promise<LlmJudgement<O>>;

/** ルールの永続化境界。 DB 実装は store.ts に隔離。 */
export interface RuleStore {
  listByDomain(domain: string): Rule[];
  insert(draft: RuleDraft): Rule;
  update(id: string, patch: Partial<Pick<Rule, 'enabled' | 'approvals' | 'rejections' | 'confidence' | 'priority' | 'description'>>): Rule | null;
  get(id: string): Rule | null;
}

/** 判断 ledger の永続化境界。 */
export interface DecisionLedger {
  record(rec: Omit<DecisionRecord, 'id' | 'verdict' | 'reviewedAt'>): number;
  get(id: number): DecisionRecord | null;
  setVerdict(id: number, verdict: 'ok' | 'ng', reviewedAt: string): void;
}
