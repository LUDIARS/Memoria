import { normalizeModelId } from './price-table.js';
import type { UsageTokens } from './types.js';

// https://learn.chatgpt.com/docs/pricing (checked 2026-09-29), Standard speed,
// credits per 1M tokens: [input, cached input, output]. Codex credits are drawn
// from the ChatGPT plan, a unit separate from API USD; models the rate card does
// not list return null instead of a borrowed rate.
const CODEX_CREDIT_RATES: Record<string, [input: number, cacheRead: number, output: number]> = {
  'gpt-6-astra': [250, 25, 1_250],
  'gpt-6-sol': [50, 5, 250],
  'gpt-6-luna': [2.5, 0.25, 12.5],
  'gpt-5.6-sol': [100, 10, 500],
  'gpt-5.6-luna': [5, 0.5, 30],
};

export function estimateCodexCredits(model: string, usage: UsageTokens): number | null {
  const rates = CODEX_CREDIT_RATES[normalizeModelId('codex-cli', model)];
  if (!rates) return null;
  const [input, cacheRead, output] = rates;
  return (usage.inputTokens * input + usage.cacheReadTokens * cacheRead + usage.outputTokens * output)
    / 1_000_000;
}
