export type LlmProvider = 'claude-code' | 'codex-cli';

/**
 * Token counts for one billed model response.
 *
 * `outputTokens` already contains thinking / reasoning tokens for both providers,
 * so no separate thinking count is ever added on top of it.
 */
export interface UsageTokens {
  /** Uncached input tokens (Codex `input_tokens - cached_input_tokens`). */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /** Cache writes whose TTL the log did not report (no `cache_creation` breakdown). */
  cacheWriteUnknownTokens: number;
  outputTokens: number;
}

/** One provider response, deduplicated across stream fragments and copied history. */
export interface UsageResponse extends UsageTokens {
  provider: LlmProvider;
  /** Provider response identity (Claude `message.id`; Codex cumulative token_count key). */
  responseId: string;
  /** Session that produced the response (Claude subagents keep their parent session). */
  sessionId: string;
  /** Subagent id for Claude sidechains; null for the main conversation. */
  agentId: string | null;
  /** Root session the response belongs to (parent for subagents / forks). */
  familyId: string;
  /** True when read from the log file that originally recorded the response. */
  isOrigin: boolean;
  sourcePath: string;
  occurredAt: string;
  occurredMs: number;
  /** JST calendar date of `occurredAt`. */
  usageDate: string;
  model: string;
  effort: string;
  repoPath: string | null;
}

export interface CostBreakdown {
  inputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  outputUsd: number;
}

/** Official list-price API equivalent. Not an invoice, not subscription quota. */
export interface CostEstimate {
  /** null when the model has no official price: never summed as $0. */
  usd: number | null;
  breakdown: CostBreakdown | null;
  basis: string;
  /** Codex credits from the ChatGPT rate card; null when not applicable or unlisted. */
  codexCredits: number | null;
  priceVersion: string;
}

export interface PricedUsageResponse extends UsageResponse {
  cost: CostEstimate;
}

export interface ParsedUsageSource {
  provider: LlmProvider;
  sessionId: string;
  responses: UsageResponse[];
}

export interface SourceSignature {
  path: string;
  provider: LlmProvider;
  modifiedMs: number;
  sizeBytes: number;
}

export interface SyncResult {
  scannedSources: number;
  importedSources: number;
  unchangedSources: number;
  failedSources: number;
  importedResponses: number;
  repricedResponses: number;
  inventoryCaptured: boolean;
}

export interface LocalLlmModel {
  id: string;
}
