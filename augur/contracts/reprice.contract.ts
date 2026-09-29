// Contract for repriceStaleResponses (spec/tasks/2026-09-29-llm-usage-cost-accuracy.md, C-4).
// After a re-price no stored response may keep a cost from another rate table.

type Db = { prepare: (sql: string) => { all: () => Array<{ price_version: string }> } };

export default {
  post: (_result: number, db: Db): true | string => {
    const versions = new Set(
      db.prepare('SELECT DISTINCT price_version FROM llm_usage_responses').all().map((row) => row.price_version),
    );
    return versions.size <= 1 || 'every response must share the current price version after re-pricing';
  },
};
