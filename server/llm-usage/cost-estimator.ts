import { estimateCodexCredits } from './codex-credits.js';
import { findModelPrice, PRICE_TABLE_VERSION } from './price-table.js';
import type { CostEstimate, LlmProvider, UsageTokens } from './types.js';

export const UNPRICED_BASIS = 'unpriced';

/**
 * Official list-price API equivalent of one response. This is not an invoice and
 * not subscription quota. Cache writes with an unknown TTL are priced at the
 * 5-minute rate, the lower bound, and stay visible as their own token count.
 */
export function estimateResponseCost(provider: LlmProvider, model: string, usage: UsageTokens): CostEstimate {
  const codexCredits = provider === 'codex-cli' ? estimateCodexCredits(model, usage) : null;
  const price = findModelPrice(provider, model);
  if (!price) {
    return { usd: null, breakdown: null, basis: UNPRICED_BASIS, codexCredits, priceVersion: PRICE_TABLE_VERSION };
  }
  const breakdown = {
    inputUsd: perMillion(usage.inputTokens, price.inputPerMillion),
    cacheReadUsd: perMillion(usage.cacheReadTokens, price.cacheReadPerMillion),
    cacheWriteUsd: perMillion(usage.cacheWrite5mTokens + usage.cacheWriteUnknownTokens, price.cacheWrite5mPerMillion)
      + perMillion(usage.cacheWrite1hTokens, price.cacheWrite1hPerMillion),
    outputUsd: perMillion(usage.outputTokens, price.outputPerMillion),
  };
  return {
    usd: breakdown.inputUsd + breakdown.cacheReadUsd + breakdown.cacheWriteUsd + breakdown.outputUsd,
    breakdown,
    basis: price.basis,
    codexCredits,
    priceVersion: PRICE_TABLE_VERSION,
  };
}

function perMillion(tokens: number, usdPerMillion: number): number {
  return tokens * usdPerMillion / 1_000_000;
}
