// Contract for estimateResponseCost (spec/tasks/2026-09-29-llm-usage-cost-accuracy.md, C-1).
// An unpriced model must never look like a $0 response, and a priced total must
// be reconcilable from its input / cache / output parts.

type Breakdown = { inputUsd: number; cacheReadUsd: number; cacheWriteUsd: number; outputUsd: number };
type Estimate = { usd: number | null; breakdown: Breakdown | null; basis: string };

export default {
  post: (result: Estimate): true | string => {
    if (result.basis === 'unpriced') {
      return (result.usd === null && result.breakdown === null) || 'unpriced cost must be null, not $0';
    }
    if (result.usd === null || result.breakdown === null) return 'priced cost must carry usd and breakdown';
    const parts = result.breakdown;
    const sum = parts.inputUsd + parts.cacheReadUsd + parts.cacheWriteUsd + parts.outputUsd;
    return Math.abs(sum - result.usd) < 1e-9 || 'usd must equal the breakdown sum';
  },
};
