import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateResponseCost, UNPRICED_BASIS } from './cost-estimator.js';
import { findModelPrice, PRICE_TABLE_VERSION } from './price-table.js';
import type { UsageTokens } from './types.js';

const MILLION = 1_000_000;

function tokens(overrides: Partial<UsageTokens>): UsageTokens {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheWriteUnknownTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

function close(actual: number | null, expected: number): void {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

test('Opus 5.5 uses its own official rates, not the older Opus row', () => {
  const cost = estimateResponseCost('claude-code', 'claude-opus-5-5', tokens({
    inputTokens: MILLION,
    cacheWrite5mTokens: MILLION,
    cacheWrite1hTokens: MILLION,
    cacheReadTokens: MILLION,
    outputTokens: MILLION,
  }));
  assert.equal(cost.basis, 'anthropic:claude-opus-5-5');
  close(cost.breakdown?.inputUsd ?? null, 4);
  close(cost.breakdown?.cacheWriteUsd ?? null, 5 + 8);
  // 0.05x base input, not the generic 0.1x.
  close(cost.breakdown?.cacheReadUsd ?? null, 0.2);
  close(cost.breakdown?.outputUsd ?? null, 20);
  close(cost.usd, 4 + 5 + 8 + 0.2 + 20);
  assert.equal(cost.priceVersion, PRICE_TABLE_VERSION);
});

test('exact ids are matched before family prefixes', () => {
  assert.equal(findModelPrice('claude-code', 'claude-opus-5')?.inputPerMillion, 5);
  assert.equal(findModelPrice('claude-code', 'claude-opus-5-5')?.inputPerMillion, 4);
  assert.equal(findModelPrice('claude-code', 'claude-fable-5')?.cacheReadPerMillion, 1);
  assert.equal(findModelPrice('claude-code', 'claude-fable-5-1')?.cacheReadPerMillion, 0.25);
  assert.equal(findModelPrice('claude-code', 'claude-sonnet-4')?.inputPerMillion, 3);
  assert.equal(findModelPrice('claude-code', 'claude-sonnet-4-6')?.inputPerMillion, 3);
  assert.equal(findModelPrice('claude-code', 'claude-sonnet-5')?.inputPerMillion, 2);
});

test('date, region and context-window suffixes resolve to the same model', () => {
  assert.equal(findModelPrice('claude-code', 'claude-haiku-4-5-20251001')?.id, 'claude-haiku-4-5');
  assert.equal(findModelPrice('claude-code', 'claude-opus-5-5[1m]')?.id, 'claude-opus-5-5');
  assert.equal(findModelPrice('claude-code', 'us.anthropic.claude-opus-5-5-v1:0')?.id, 'claude-opus-5-5');
  assert.equal(findModelPrice('codex-cli', '5.3-codex')?.id, 'gpt-5.3-codex');
});

test('unpriced models are not summed as $0', () => {
  for (const [provider, model] of [
    ['claude-code', 'opus'],
    ['claude-code', 'claude-opus-9'],
    ['codex-cli', 'gpt-5-codex'],
    ['codex-cli', 'codex-auto-review'],
  ] as const) {
    const cost = estimateResponseCost(provider, model, tokens({ inputTokens: MILLION, outputTokens: MILLION }));
    assert.equal(cost.usd, null, model);
    assert.equal(cost.breakdown, null, model);
    assert.equal(cost.basis, UNPRICED_BASIS, model);
  }
});

test('GPT-6 and GPT-5.6 use official OpenAI rates, not Claude proxies', () => {
  const usage = tokens({ inputTokens: MILLION, cacheReadTokens: MILLION, outputTokens: MILLION });
  const astra = estimateResponseCost('codex-cli', 'gpt-6-astra', usage);
  assert.equal(astra.basis, 'openai:gpt-6-astra');
  close(astra.usd, 10 + 1 + 50);
  close(estimateResponseCost('codex-cli', 'gpt-6-sol', usage).usd, 2 + 0.2 + 10);
  close(estimateResponseCost('codex-cli', 'gpt-5.6-sol', usage).usd, 4 + 0.4 + 20);
  close(estimateResponseCost('codex-cli', 'gpt-5.6-terra', usage).usd, 2 + 0.2 + 12);
  close(estimateResponseCost('codex-cli', 'gpt-5.3-codex', usage).usd, 1.75 + 0.175 + 14);
});

test('Codex credits are reported separately from API USD', () => {
  const usage = tokens({ inputTokens: MILLION, cacheReadTokens: MILLION, outputTokens: MILLION });
  close(estimateResponseCost('codex-cli', 'gpt-6-astra', usage).codexCredits, 250 + 25 + 1_250);
  close(estimateResponseCost('codex-cli', 'gpt-5.6-sol', usage).codexCredits, 100 + 10 + 500);
  // Listed for API but not on the credit card: no borrowed credit rate.
  assert.equal(estimateResponseCost('codex-cli', 'gpt-5.6-terra', usage).codexCredits, null);
  assert.equal(estimateResponseCost('claude-code', 'claude-opus-5-5', usage).codexCredits, null);
});

test('cache writes with unknown TTL are priced at the 5-minute lower bound', () => {
  const cost = estimateResponseCost('claude-code', 'claude-opus-5-5', tokens({ cacheWriteUnknownTokens: MILLION }));
  close(cost.breakdown?.cacheWriteUsd ?? null, 5);
});
