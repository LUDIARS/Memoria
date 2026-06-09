// 成長型ブラックボックスの中核アルゴリズム。
//
// decide(): ルール優先 → 未承認は pending_review で人間 OK/NG 待ち →
//           ルール無しなら LLM フォールバック。 全判断を ledger に記録。
// recordVerdict(): 人間の OK/NG でルールの信頼を更新し、 閾値で auto 化 / 撤回。
//
// Memoria 非依存: 永続化と LLM は注入された interface 越しにのみ触る。

import type {
  Decision, DecisionLedger, FeatureMap, LlmFallback,
  Rule, RuleDraft, RuleStore,
} from './types.js';
import { evaluate, describeCondition } from './condition.js';

export interface EngineOptions {
  /** approvals がこの数に達するとルールは auto (LLM を呼ばない)。 */
  autoPromoteThreshold?: number;
  /** rejections がこの数に達するとルールは無効化 (LLM に差し戻し)。 */
  autoRetractThreshold?: number;
}

const DEFAULT_AUTO_PROMOTE = 3;
const DEFAULT_AUTO_RETRACT = 3;

export class BlackBoxEngine {
  private readonly promote: number;
  private readonly retract: number;

  constructor(
    private readonly rules: RuleStore,
    private readonly ledger: DecisionLedger,
    opts: EngineOptions = {},
  ) {
    this.promote = opts.autoPromoteThreshold ?? DEFAULT_AUTO_PROMOTE;
    this.retract = opts.autoRetractThreshold ?? DEFAULT_AUTO_RETRACT;
  }

  /** domain の enabled ルールを priority 降順で評価し最初のヒットを返す。 */
  private firstMatch(domain: string, features: FeatureMap): Rule | null {
    const rules = this.rules.listByDomain(domain)
      .filter((r) => r.enabled)
      .sort((a, b) => b.priority - a.priority);
    for (const r of rules) {
      if (evaluate(r.when, features)) return r;
    }
    return null;
  }

  /**
   * domain の判断を下す。 結果は ledger に記録され decisionId が付与される。
   * 戻り値の decisionId で後から recordVerdict できる。
   */
  async decide<I, O>(
    domain: string,
    input: I,
    features: FeatureMap,
    llmFallback: LlmFallback<I, O>,
  ): Promise<{ decision: Decision<O>; decisionId: number }> {
    const hit = this.firstMatch(domain, features);

    if (hit) {
      const trusted = hit.approvals >= this.promote;
      const decision: Decision<O> = {
        output: hit.output as O,
        source: 'rule',
        ruleId: hit.id,
        confidence: hit.confidence,
        rationale: trusted
          ? `ルール「${hit.description}」で判定 (${describeCondition(hit.when)})`
          : `ルール「${hit.description}」で先に判定しました — OK/NG をお願いします (承認 ${hit.approvals}/${this.promote})`,
        status: trusted ? 'auto' : 'pending_review',
      };
      const decisionId = this.ledger.record({
        domain, input, features,
        output: decision.output, source: 'rule', ruleId: hit.id,
        confidence: decision.confidence, rationale: decision.rationale,
        status: decision.status, createdAt: new Date().toISOString(),
      });
      return { decision, decisionId };
    }

    // ルール無し → LLM に判断させ、 ルール候補があれば disabled で登録。
    const j = await llmFallback(input, features);
    if (j.proposedRule) {
      try {
        this.rules.insert({ ...j.proposedRule, domain, source: 'llm', enabled: false });
      } catch { /* 候補登録の失敗は判断本体を止めない */ }
    }
    const decision: Decision<O> = {
      output: j.output,
      source: 'llm',
      confidence: j.confidence,
      rationale: `LLM が判定: ${j.rationale}`,
      status: 'auto',
    };
    const decisionId = this.ledger.record({
      domain, input, features,
      output: decision.output, source: 'llm', ruleId: null,
      confidence: decision.confidence, rationale: decision.rationale,
      status: 'auto', createdAt: new Date().toISOString(),
    });
    return { decision, decisionId };
  }

  /**
   * 人間の OK/NG を記録する。
   * - ルール由来 OK → approvals++ (閾値到達で auto 化)
   * - ルール由来 NG → rejections++ (閾値到達でルール無効化 = 自己修復)
   * - LLM 由来は教師ラベルとして ledger に残すのみ。
   */
  recordVerdict(decisionId: number, verdict: 'ok' | 'ng'): { ok: boolean; ruleUpdated?: Rule } {
    const rec = this.ledger.get(decisionId);
    if (!rec) return { ok: false };
    this.ledger.setVerdict(decisionId, verdict, new Date().toISOString());

    if (rec.source !== 'rule' || !rec.ruleId) return { ok: true };
    const rule = this.rules.get(rec.ruleId);
    if (!rule) return { ok: true };

    if (verdict === 'ok') {
      const updated = this.rules.update(rule.id, { approvals: rule.approvals + 1 });
      return { ok: true, ruleUpdated: updated ?? undefined };
    }
    const rejections = rule.rejections + 1;
    const updated = this.rules.update(rule.id, {
      rejections,
      enabled: rejections >= this.retract ? false : rule.enabled,
    });
    return { ok: true, ruleUpdated: updated ?? undefined };
  }

  /** 手動 / 採掘でルールを追加する (有効状態は呼び出し側指定)。 */
  addRule(draft: RuleDraft): Rule {
    return this.rules.insert(draft);
  }

  toggleRule(id: string, enabled: boolean): Rule | null {
    return this.rules.update(id, { enabled });
  }

  listRules(domain: string): Rule[] {
    return this.rules.listByDomain(domain);
  }
}
