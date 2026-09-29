import type { LlmProvider } from './types.js';

/**
 * Bump whenever any rate below changes. Stored responses carry the version they
 * were priced with, and sync re-prices every response whose version differs —
 * native log mtimes do not change when a rate does, so the log cache alone
 * would otherwise keep stale costs forever.
 */
export const PRICE_TABLE_VERSION = '2026-09-29';

/** USD per 1M tokens, taken verbatim from the provider's official price page. */
export interface ModelPrice {
  id: string;
  basis: string;
  inputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWrite5mPerMillion: number;
  cacheWrite1hPerMillion: number;
  outputPerMillion: number;
}

type Rates = [input: number, write5m: number, write1h: number, cacheRead: number, output: number];

// https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-09-29).
// Cache reads are stored as absolute rates: Opus 5.5 is 0.05x and Fable/Mythos
// 5.1 are 0.025x, so one shared multiplier would misprice them.
const CLAUDE_RATES: Record<string, Rates> = {
  'claude-fable-5-1': [10, 12.5, 20, 0.25, 50],
  'claude-mythos-5-1': [10, 12.5, 20, 0.25, 50],
  'claude-fable-5': [10, 12.5, 20, 1, 50],
  'claude-mythos-5': [10, 12.5, 20, 1, 50],
  'claude-opus-5-5': [4, 5, 8, 0.2, 20],
  'claude-opus-5': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-8': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-7': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-6': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-5': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-1': [15, 18.75, 30, 1.5, 75],
  'claude-opus-4': [15, 18.75, 30, 1.5, 75],
  'claude-sonnet-5-5': [2, 2.5, 4, 0.2, 10],
  'claude-sonnet-5': [2, 2.5, 4, 0.2, 10],
  'claude-sonnet-4-6': [3, 3.75, 6, 0.3, 15],
  'claude-sonnet-4-5': [3, 3.75, 6, 0.3, 15],
  'claude-sonnet-4': [3, 3.75, 6, 0.3, 15],
  'claude-haiku-4-5': [1, 1.25, 2, 0.1, 5],
  'claude-haiku-3-5': [0.8, 1, 1.6, 0.08, 4],
};

// https://developers.openai.com/api/docs/pricing (checked 2026-09-29), standard tier.
// [input, cached input, output]. Codex logs never report cache writes. Models the
// page does not list (e.g. gpt-5-codex, codex auto-review) stay unpriced instead of
// borrowing a Claude or sibling rate.
const OPENAI_RATES: Record<string, [input: number, cacheRead: number, output: number]> = {
  'gpt-6-astra': [10, 1, 50],
  'gpt-6-sol': [2, 0.2, 10],
  'gpt-6-luna': [0.1, 0.01, 0.5],
  'gpt-5.6-sol': [4, 0.4, 20],
  'gpt-5.6-terra': [2, 0.2, 12],
  'gpt-5.6-luna': [0.2, 0.02, 1.2],
  'gpt-5.5': [5, 0.5, 30],
  'gpt-5.4': [2.5, 0.25, 15],
  'gpt-5.3-codex': [1.75, 0.175, 14],
  'gpt-5.2': [1.75, 0.175, 14],
  'gpt-5.1': [1.25, 0.125, 10],
  'gpt-5': [1.25, 0.125, 10],
};

/**
 * Resolve the official price for an exact model id. Only date / region / context
 * suffixes are stripped; family aliases (`opus`, `sonnet`) and unknown ids return
 * null so they surface as unpriced rather than as a guessed rate.
 */
export function findModelPrice(provider: LlmProvider, rawModel: string): ModelPrice | null {
  const id = normalizeModelId(provider, rawModel);
  if (provider === 'claude-code') {
    const rates = CLAUDE_RATES[id];
    if (!rates) return null;
    const [input, write5m, write1h, cacheRead, output] = rates;
    return {
      id,
      basis: `anthropic:${id}`,
      inputPerMillion: input,
      cacheReadPerMillion: cacheRead,
      cacheWrite5mPerMillion: write5m,
      cacheWrite1hPerMillion: write1h,
      outputPerMillion: output,
    };
  }
  const rates = OPENAI_RATES[id];
  if (!rates) return null;
  const [input, cacheRead, output] = rates;
  return {
    id,
    basis: `openai:${id}`,
    inputPerMillion: input,
    cacheReadPerMillion: cacheRead,
    cacheWrite5mPerMillion: input,
    cacheWrite1hPerMillion: input,
    outputPerMillion: output,
  };
}

export function normalizeModelId(provider: LlmProvider, rawModel: string): string {
  let id = rawModel.trim().toLowerCase();
  if (provider === 'claude-code') {
    id = id
      .replace(/\[[^\]]*\]$/, '') // context-window tag such as `[1m]`
      .replace(/^(?:[a-z]{2,4}\.)?anthropic\./, '') // Bedrock `us.anthropic.` prefix
      .replace(/-v\d+(?::\d+)?$/, '') // Bedrock `-v1:0` revision
      .replace(/-\d{8}$/, ''); // dated snapshot
    return id;
  }
  id = id.replace(/^openai\//, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  // Codex has logged bare ids such as `5.3-codex`.
  if (/^\d/.test(id)) id = `gpt-${id}`;
  return id;
}
