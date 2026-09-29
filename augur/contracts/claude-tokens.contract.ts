// Contract for claudeTokens (spec/tasks/2026-09-29-llm-usage-cost-accuracy.md, C-3).
// Every cache-write token lands in exactly one TTL bucket; writes without a
// breakdown are kept as unknown instead of being dropped or assumed 5m.

type Tokens = { cacheWrite5mTokens: number; cacheWrite1hTokens: number; cacheWriteUnknownTokens: number };
type Usage = { cache_creation_input_tokens?: unknown };

export default {
  post: (result: Tokens, usage: Usage): true | string => {
    const reported = typeof usage.cache_creation_input_tokens === 'number'
      ? Math.max(0, Math.floor(usage.cache_creation_input_tokens))
      : 0;
    const known = result.cacheWrite5mTokens + result.cacheWrite1hTokens;
    const total = known + result.cacheWriteUnknownTokens;
    if (result.cacheWriteUnknownTokens < 0) return 'unknown TTL writes must not be negative';
    return total === Math.max(reported, known) || 'cache write buckets must add up to the reported total';
  },
};
