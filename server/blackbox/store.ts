// 成長型ブラックボックスの永続化 (Memoria 束縛)。
//
// blackbox_rules / blackbox_decisions テーブルへの SQLite 実装。 better-sqlite3 に
// 依存する唯一のファイル。 他サービスへ移植する際はこの 2 クラスを差し替えるだけ。
// テーブル定義は db.ts (spec/data/blackbox.md)。

import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  DecisionLedger, DecisionRecord, FeatureMap, Rule, RuleDraft, RuleStore,
} from './types.js';

type Db = BetterSqlite3.Database;

interface RuleRow {
  id: string; domain: string; description: string;
  when_json: string; output_json: string;
  confidence: number; enabled: number; source: string;
  approvals: number; rejections: number; priority: number;
  created_at: string; updated_at: string;
}

function rowToRule(r: RuleRow): Rule {
  return {
    id: r.id, domain: r.domain, description: r.description,
    when: JSON.parse(r.when_json) as Rule['when'],
    output: r.output_json ? JSON.parse(r.output_json) : null,
    confidence: r.confidence, enabled: r.enabled === 1,
    source: r.source as Rule['source'],
    approvals: r.approvals, rejections: r.rejections, priority: r.priority,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class SqliteRuleStore implements RuleStore {
  constructor(private readonly db: Db) {}

  listByDomain(domain: string): Rule[] {
    const rows = this.db.prepare(
      `SELECT * FROM blackbox_rules WHERE domain = ? ORDER BY priority DESC, created_at ASC`,
    ).all(domain) as RuleRow[];
    return rows.map(rowToRule);
  }

  get(id: string): Rule | null {
    const row = this.db.prepare(`SELECT * FROM blackbox_rules WHERE id = ?`).get(id) as RuleRow | undefined;
    return row ? rowToRule(row) : null;
  }

  insert(draft: RuleDraft): Rule {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO blackbox_rules
         (id, domain, description, when_json, output_json, confidence, enabled, source, approvals, rejections, priority, created_at, updated_at)
       VALUES (@id, @domain, @description, @when_json, @output_json, @confidence, @enabled, @source, 0, 0, @priority, @created_at, @updated_at)`,
    ).run({
      id,
      domain: draft.domain,
      description: draft.description,
      when_json: JSON.stringify(draft.when),
      output_json: JSON.stringify(draft.output ?? null),
      confidence: draft.confidence ?? 0.7,
      enabled: draft.enabled === false ? 0 : 1,
      source: draft.source ?? 'manual',
      priority: draft.priority ?? 0,
      created_at: now,
      updated_at: now,
    });
    return this.get(id)!;
  }

  update(id: string, patch: Partial<Pick<Rule, 'enabled' | 'approvals' | 'rejections' | 'confidence' | 'priority' | 'description'>>): Rule | null {
    const cur = this.get(id);
    if (!cur) return null;
    const next = {
      enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (cur.enabled ? 1 : 0),
      approvals: patch.approvals ?? cur.approvals,
      rejections: patch.rejections ?? cur.rejections,
      confidence: patch.confidence ?? cur.confidence,
      priority: patch.priority ?? cur.priority,
      description: patch.description ?? cur.description,
      updated_at: new Date().toISOString(),
      id,
    };
    this.db.prepare(
      `UPDATE blackbox_rules SET enabled=@enabled, approvals=@approvals, rejections=@rejections,
         confidence=@confidence, priority=@priority, description=@description, updated_at=@updated_at
       WHERE id=@id`,
    ).run(next);
    return this.get(id);
  }
}

interface DecisionRow {
  id: number; domain: string; input_json: string; features_json: string;
  output_json: string; source: string; rule_id: string | null;
  confidence: number; rationale: string; status: string;
  verdict: string | null; created_at: string; reviewed_at: string | null;
}

function rowToDecision(r: DecisionRow): DecisionRecord {
  return {
    id: r.id, domain: r.domain,
    input: r.input_json ? JSON.parse(r.input_json) : null,
    features: (r.features_json ? JSON.parse(r.features_json) : {}) as FeatureMap,
    output: r.output_json ? JSON.parse(r.output_json) : null,
    source: r.source as DecisionRecord['source'],
    ruleId: r.rule_id,
    confidence: r.confidence, rationale: r.rationale,
    status: r.status as DecisionRecord['status'],
    verdict: r.verdict as DecisionRecord['verdict'],
    createdAt: r.created_at, reviewedAt: r.reviewed_at,
  };
}

export class SqliteDecisionLedger implements DecisionLedger {
  constructor(private readonly db: Db) {}

  record(rec: Omit<DecisionRecord, 'id' | 'verdict' | 'reviewedAt'>): number {
    const info = this.db.prepare(
      `INSERT INTO blackbox_decisions
         (domain, input_json, features_json, output_json, source, rule_id, confidence, rationale, status, verdict, created_at, reviewed_at)
       VALUES (@domain, @input_json, @features_json, @output_json, @source, @rule_id, @confidence, @rationale, @status, NULL, @created_at, NULL)`,
    ).run({
      domain: rec.domain,
      input_json: JSON.stringify(rec.input ?? null),
      features_json: JSON.stringify(rec.features ?? {}),
      output_json: JSON.stringify(rec.output ?? null),
      source: rec.source,
      rule_id: rec.ruleId,
      confidence: rec.confidence,
      rationale: rec.rationale,
      status: rec.status,
      created_at: rec.createdAt,
    });
    return Number(info.lastInsertRowid);
  }

  get(id: number): DecisionRecord | null {
    const row = this.db.prepare(`SELECT * FROM blackbox_decisions WHERE id = ?`).get(id) as DecisionRow | undefined;
    return row ? rowToDecision(row) : null;
  }

  setVerdict(id: number, verdict: 'ok' | 'ng', reviewedAt: string): void {
    this.db.prepare(`UPDATE blackbox_decisions SET verdict = ?, reviewed_at = ? WHERE id = ?`).run(verdict, reviewedAt, id);
  }

  /** UI のレビュー待ちキュー: pending_review でまだ verdict が無い判断。 */
  listPending(domain?: string, limit = 50): DecisionRecord[] {
    const rows = domain
      ? this.db.prepare(
          `SELECT * FROM blackbox_decisions WHERE status='pending_review' AND verdict IS NULL AND domain=? ORDER BY created_at DESC LIMIT ?`,
        ).all(domain, limit) as DecisionRow[]
      : this.db.prepare(
          `SELECT * FROM blackbox_decisions WHERE status='pending_review' AND verdict IS NULL ORDER BY created_at DESC LIMIT ?`,
        ).all(limit) as DecisionRow[];
    return rows.map(rowToDecision);
  }
}
