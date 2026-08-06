import type { LlmProvider, UsageAmounts } from './types.js';

interface PriceScale {
  inputPerMillion: number;
  outputPerMillion: number;
  basis: string;
}
export interface CostEstimate {
  usd: number;
  basis: string;
}

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;

/** Villa /session-costs の比較スケール。実請求額ではなく等価 API コスト。 */
export function estimateEquivalentApiCost(
  provider: LlmProvider,
  model: string,
  usage: Pick<UsageAmounts, 'inputTokens' | 'cachedInputTokens' | 'cacheWrite5mTokens' | 'cacheWrite1hTokens' | 'outputTokens'>,
): CostEstimate {
  const scale = priceScale(provider, model);
  if (!scale) return { usd: 0, basis: 'unpriced' };
  const inputCost = usage.inputTokens * scale.inputPerMillion;
  const cacheReadCost = usage.cachedInputTokens * scale.inputPerMillion * CACHE_READ_MULTIPLIER;
  const cacheWrite5mCost = usage.cacheWrite5mTokens * scale.inputPerMillion * CACHE_WRITE_5M_MULTIPLIER;
  const cacheWrite1hCost = usage.cacheWrite1hTokens * scale.inputPerMillion * CACHE_WRITE_1H_MULTIPLIER;
  const outputCost = usage.outputTokens * scale.outputPerMillion;
  return {
    usd: (inputCost + cacheReadCost + cacheWrite5mCost + cacheWrite1hCost + outputCost) / 1_000_000,
    basis: scale.basis,
  };
}

function priceScale(provider: LlmProvider, rawModel: string): PriceScale | null {
  const model = rawModel.toLowerCase();
  if (provider === 'codex-cli') {
    if (model.includes('5.6-sol')) return { inputPerMillion: 10, outputPerMillion: 50, basis: 'proxy:fable-5' };
    if (model.includes('5.6-terra')) return { inputPerMillion: 5, outputPerMillion: 25, basis: 'proxy:opus-4.8' };
    if (model.includes('auto-review')) return { inputPerMillion: 3, outputPerMillion: 15, basis: 'proxy:sonnet-5' };
    if (model.includes('5.3-codex') || model.includes('gpt-5-codex')) {
      return { inputPerMillion: 1.25, outputPerMillion: 10, basis: 'openai:gpt-5-codex' };
    }
    return null;
  }
  if (/claude-(fable|mythos)-5/.test(model)) {
    return { inputPerMillion: 10, outputPerMillion: 50, basis: 'villa:fable-mythos-5' };
  }
  if (/claude-opus-5/.test(model)) {
    return { inputPerMillion: 5, outputPerMillion: 25, basis: 'proxy:opus-4.8' };
  }
  if (/claude-opus-4-[5-8]/.test(model)) {
    return { inputPerMillion: 5, outputPerMillion: 25, basis: 'villa:opus-4.5-4.8' };
  }
  if (/claude-opus-(4-[01]|3)/.test(model)) {
    return { inputPerMillion: 15, outputPerMillion: 75, basis: 'villa:legacy-opus' };
  }
  if (/claude-sonnet-[45]/.test(model) || model === 'sonnet') {
    return { inputPerMillion: 3, outputPerMillion: 15, basis: 'villa:sonnet-4-5' };
  }
  if (/claude-haiku-4-5/.test(model) || model === 'haiku') {
    return { inputPerMillion: 1, outputPerMillion: 5, basis: 'villa:haiku-4.5' };
  }
  return null;
}
