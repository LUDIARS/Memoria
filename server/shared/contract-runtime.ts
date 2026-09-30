import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Runtime for Augur `contract-wrap` (augur.contracts.json#importFrom).
 *
 * The published `@ludiars/log-weaver@0.1.0` has no `contract` export, so the
 * wrappers import this module instead. It writes the same three weaver messages
 * (`contract observed` / `contract violated` / `contract predicate threw`) with
 * the ctx keys `augur contracts report` reads.
 *
 * Observation is opt-in: without `LOG_WEAVER=1` the wrapped function runs
 * unchanged and no predicate is evaluated, because sync calls the wrapped
 * parsers once per log line. Arguments and results are never written; only the
 * reason string a predicate returns.
 */

type Verdict = true | false | string;

export interface ContractSpec<A extends unknown[], R> {
  contractId: string;
  id: string;
  where: string;
  rule?: string;
  pre?: (...args: A) => Verdict;
  post?: (result: Awaited<R>, ...args: A) => Verdict;
  mode?: 'observe' | 'enforce';
  sample?: number;
}

function enabled(): boolean {
  return process.env.LOG_WEAVER === '1';
}

function record(level: string, msg: string, ctx: Record<string, string>): void {
  try {
    const directory = process.env.VESTIGIUM_LOGS_DIR || join(process.cwd(), 'logs');
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, 'contracts.jsonl'), `${JSON.stringify({ level, msg, ctx })}\n`, 'utf8');
  } catch {
    // Observation must never change the wrapped operation.
  }
}

function reasonOf(verdict: Verdict | undefined): string | null {
  if (verdict === true || verdict === undefined) return null;
  return verdict === false ? 'predicate returned false' : verdict;
}

export function contract<T, A extends unknown[], R>(
  fn: (this: T, ...args: A) => R,
  spec: ContractSpec<A, R>,
): (this: T, ...args: A) => R {
  const { contractId, id, where, pre, post } = spec;
  return function contracted(this: T, ...args: A): R {
    if (!enabled()) return fn.apply(this, args);
    const ctx = (): Record<string, string> => ({
      contract: contractId, id, where, rule: spec.rule ?? 'contract-wrap', observed_at: new Date().toISOString(),
    });
    let violated = false;
    try {
      const reason = reasonOf(pre?.(...args));
      if (reason !== null) {
        violated = true;
        record('error', 'contract violated', { ...ctx(), phase: 'pre', reason });
      }
    } catch {
      violated = true;
      record('warn', 'contract predicate threw', { ...ctx(), phase: 'predicate', predicate_phase: 'pre' });
    }
    const observe = (result: Awaited<R>): void => {
      try {
        const reason = reasonOf(post?.(result, ...args));
        if (reason !== null) record('error', 'contract violated', { ...ctx(), phase: 'post', reason });
        else if (!violated) record('debug', 'contract observed', { ...ctx(), phase: 'ok' });
      } catch {
        record('warn', 'contract predicate threw', { ...ctx(), phase: 'predicate', predicate_phase: 'post' });
      }
    };
    const result = fn.apply(this, args);
    if (result instanceof Promise) {
      return result.then((value: Awaited<R>) => {
        observe(value);
        return value;
      }) as R;
    }
    observe(result as Awaited<R>);
    return result;
  };
}
