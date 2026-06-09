// 成長型ブラックボックス — 公開 API。
//
// engine/condition/types はドメイン非依存。 store のみ Memoria (better-sqlite3) 束縛。
// 詳細は spec/feature/blackbox.md。

export * from './types.js';
export { evaluate, validateCondition, describeCondition } from './condition.js';
export { BlackBoxEngine, type EngineOptions } from './engine.js';
export { SqliteRuleStore, SqliteDecisionLedger } from './store.js';

import type BetterSqlite3 from 'better-sqlite3';
import { BlackBoxEngine, type EngineOptions } from './engine.js';
import { SqliteRuleStore, SqliteDecisionLedger } from './store.js';

/** Memoria 用に SQLite ストアで束ねた engine を 1 つ作る。 */
export function makeBlackBoxEngine(db: BetterSqlite3.Database, opts?: EngineOptions): {
  engine: BlackBoxEngine;
  ledger: SqliteDecisionLedger;
  rules: SqliteRuleStore;
} {
  const rules = new SqliteRuleStore(db);
  const ledger = new SqliteDecisionLedger(db);
  const engine = new BlackBoxEngine(rules, ledger, opts);
  return { engine, ledger, rules };
}
