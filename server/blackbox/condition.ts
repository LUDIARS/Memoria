// Condition AST の評価 + 妥当性チェック。 純粋関数のみ (副作用なし)。

import type { Condition, FeatureMap, FeatureValue, CmpOp } from './types.js';

const CMP_OPS: CmpOp[] = ['>', '>=', '<', '<=', '==', '!='];

/** Condition を features に対して評価する。 未知 feature や型不一致は false。 */
export function evaluate(cond: Condition, features: FeatureMap): boolean {
  switch (cond.op) {
    case 'and':
      return cond.clauses.every((c) => evaluate(c, features));
    case 'or':
      return cond.clauses.some((c) => evaluate(c, features));
    case 'not':
      return !evaluate(cond.clause, features);
    case 'in': {
      const v = features[cond.feature];
      if (v === undefined) return false;
      return cond.values.some((x) => x === v);
    }
    case 'cmp':
      return evalCmp(features[cond.feature], cond.cmp, cond.value);
    default:
      return false;
  }
}

function evalCmp(actual: FeatureValue | undefined, op: CmpOp, expected: FeatureValue): boolean {
  if (actual === undefined) return false;
  if (op === '==') return actual === expected;
  if (op === '!=') return actual !== expected;
  // 大小比較は number 同士のみ意味を持つ。
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  switch (op) {
    case '>': return actual > expected;
    case '>=': return actual >= expected;
    case '<': return actual < expected;
    case '<=': return actual <= expected;
    default: return false;
  }
}

/**
 * 信頼できない入力 (LLM 生成 / API body) から来た Condition を検証する。
 * 不正なら理由を投げる。 深さは DoS 対策で 8 段まで。
 */
export function validateCondition(value: unknown, depth = 0): Condition {
  if (depth > 8) throw new Error('condition nested too deep (max 8)');
  if (!value || typeof value !== 'object') throw new Error('condition must be an object');
  const c = value as Record<string, unknown>;
  switch (c.op) {
    case 'and':
    case 'or': {
      if (!Array.isArray(c.clauses) || c.clauses.length === 0) throw new Error(`${c.op} needs non-empty clauses`);
      return { op: c.op, clauses: c.clauses.map((x) => validateCondition(x, depth + 1)) };
    }
    case 'not':
      return { op: 'not', clause: validateCondition(c.clause, depth + 1) };
    case 'in': {
      if (typeof c.feature !== 'string') throw new Error('in.feature must be string');
      if (!Array.isArray(c.values) || c.values.length === 0) throw new Error('in.values must be non-empty array');
      const values = c.values.map((v) => {
        if (typeof v !== 'string' && typeof v !== 'number') throw new Error('in.values must be string|number');
        return v;
      });
      return { op: 'in', feature: c.feature, values };
    }
    case 'cmp': {
      if (typeof c.feature !== 'string') throw new Error('cmp.feature must be string');
      if (!CMP_OPS.includes(c.cmp as CmpOp)) throw new Error(`cmp.cmp must be one of ${CMP_OPS.join(',')}`);
      const v = c.value;
      if (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') {
        throw new Error('cmp.value must be number|string|boolean');
      }
      return { op: 'cmp', feature: c.feature, cmp: c.cmp as CmpOp, value: v };
    }
    default:
      throw new Error(`unknown condition op: ${String(c.op)}`);
  }
}

/** Condition を人間可読な短文に整形する (UI / 通知のルール説明用)。 */
export function describeCondition(cond: Condition): string {
  switch (cond.op) {
    case 'and': return cond.clauses.map(describeCondition).join(' かつ ');
    case 'or': return '(' + cond.clauses.map(describeCondition).join(' または ') + ')';
    case 'not': return `NOT(${describeCondition(cond.clause)})`;
    case 'in': return `${cond.feature} ∈ {${cond.values.join(', ')}}`;
    case 'cmp': return `${cond.feature} ${cond.cmp} ${String(cond.value)}`;
    default: return '?';
  }
}
