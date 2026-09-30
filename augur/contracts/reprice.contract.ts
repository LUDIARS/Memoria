// Contract for repriceStaleResponses (spec/tasks/2026-09-29-llm-usage-cost-accuracy.md, C-4).
// After a re-price no stored response may keep a cost from another rate table:
// every row carries the current PRICE_TABLE_VERSION, not merely one shared
// version (an all-stale table would otherwise pass).

import { PRICE_TABLE_VERSION } from '../../server/llm-usage/price-table.js';

// Method syntax keeps this assignable from better-sqlite3's Database.
interface Db { prepare(sql: string): { get(...params: unknown[]): unknown } }

export default {
  post: (result: number, db: Db): true | string => {
    if (!Number.isInteger(result) || result < 0) return 'repriced count must be a non-negative integer';
    const row = db.prepare(
      'SELECT COUNT(*) AS stale FROM llm_usage_responses WHERE price_version IS NOT ?',
    ).get(PRICE_TABLE_VERSION) as { stale: number };
    return row.stale === 0 || 'every response must carry the current price version after re-pricing';
  },
};
