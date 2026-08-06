export type LlmProvider = 'claude-code' | 'codex-cli';

export interface UsageAmounts {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  totalTokens: number;
  contexts: number;
  costUsd: number;
}
export interface UsageRecord extends UsageAmounts {
  sourcePath: string;
  sessionId: string;
  provider: LlmProvider;
  usageDate: string;
  model: string;
  effort: string;
  repoPath: string | null;
  startedAt: string | null;
  endedAt: string | null;
  costBasis: string;
}

export interface ParsedUsageSource {
  provider: LlmProvider;
  sessionId: string;
  records: UsageRecord[];
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
  importedRecords: number;
  inventoryCaptured: boolean;
}

export interface LocalLlmModel {
  id: string;
}
