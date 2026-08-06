import { createReadStream, type Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { estimateEquivalentApiCost } from './price-table.js';
import type {
  LlmProvider,
  ParsedUsageSource,
  SourceSignature,
  UsageAmounts,
  UsageRecord,
} from './types.js';

const CLAUDE_ROOT = join(homedir(), '.claude', 'projects');
const CODEX_ROOT = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');

interface MutableUsage extends UsageAmounts {
  costBasis: string;
  startedAt: string | null;
  endedAt: string | null;
}

interface JsonObject { [key: string]: unknown }

export async function listRecentNativeLogs(cutoffMs: number): Promise<SourceSignature[]> {
  const out: SourceSignature[] = [];
  await collectRecent(CLAUDE_ROOT, 'claude-code', cutoffMs, out);
  await collectRecent(CODEX_ROOT, 'codex-cli', cutoffMs, out);
  return out.sort((a, b) => a.modifiedMs - b.modifiedMs || a.path.localeCompare(b.path));
}

export async function parseNativeLog(
  source: SourceSignature,
  cutoffMs = Number.NEGATIVE_INFINITY,
): Promise<ParsedUsageSource> {
  return source.provider === 'claude-code'
    ? parseClaudeLog(source.path, cutoffMs)
    : parseCodexLog(source.path, cutoffMs);
}

async function collectRecent(
  root: string,
  provider: LlmProvider,
  cutoffMs: number,
  out: SourceSignature[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // A provider that has never run has no native log root.
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectRecent(path, provider, cutoffMs, out);
      continue;
    }
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.jsonl') continue;
    try {
      const info = await stat(path);
      if (info.mtimeMs >= cutoffMs) {
        out.push({ path, provider, modifiedMs: info.mtimeMs, sizeBytes: info.size });
      }
    } catch {
      // The provider may rotate a file while discovery runs; the next sync will retry it.
    }
  }
}

async function parseClaudeLog(path: string, cutoffMs: number): Promise<ParsedUsageSource> {
  const sessionId = basename(path, extname(path));
  const groups = new Map<string, MutableUsage>();
  const seen = new Set<string>();
  let repoPath: string | null = null;

  await forEachJsonLine(path, (row) => {
    repoPath = repoPath ?? text(row.cwd);
    const message = object(row.message);
    const usage = object(message?.usage);
    if (!message || !usage) return;
    const dedupId = text(message.id) || text(row.uuid);
    if (dedupId && seen.has(dedupId)) return;
    const timestamp = text(row.timestamp);
    if (!isAtOrAfter(timestamp, cutoffMs)) return;
    if (dedupId) seen.add(dedupId);
    const date = jstDate(timestamp);
    if (!date) return;
    const model = text(message.model) || 'unknown';
    const cacheCreation = object(usage.cache_creation);
    const cacheWriteTotal = nonNegative(usage.cache_creation_input_tokens);
    const write5m = cacheCreation
      ? nonNegative(cacheCreation.ephemeral_5m_input_tokens)
      : cacheWriteTotal;
    const write1h = cacheCreation ? nonNegative(cacheCreation.ephemeral_1h_input_tokens) : 0;
    const amount = getGroup(groups, date, model, 'unknown');
    amount.inputTokens += nonNegative(usage.input_tokens);
    amount.cachedInputTokens += nonNegative(usage.cache_read_input_tokens);
    amount.cacheWrite5mTokens += write5m;
    amount.cacheWrite1hTokens += write1h;
    amount.outputTokens += nonNegative(usage.output_tokens);
    amount.contexts += 1;
    updateSpan(amount, timestamp);
  });

  return {
    provider: 'claude-code',
    sessionId,
    records: finalizeGroups(path, sessionId, 'claude-code', repoPath, groups),
  };
}

async function parseCodexLog(path: string, cutoffMs: number): Promise<ParsedUsageSource> {
  let sessionId = basename(path, extname(path));
  let repoPath: string | null = null;
  let model = 'unknown';
  let effort = 'unknown';
  let previous = { input: 0, cached: 0, output: 0 };
  const groups = new Map<string, MutableUsage>();

  await forEachJsonLine(path, (row) => {
    const payload = object(row.payload);
    if (row.type === 'session_meta' && payload) {
      sessionId = text(payload.id) || sessionId;
      repoPath = text(payload.cwd) || repoPath;
      return;
    }
    if (row.type === 'turn_context' && payload) {
      model = text(payload.model) || model;
      effort = text(payload.effort) || effort;
      repoPath = text(payload.cwd) || repoPath;
      const timestamp = text(row.timestamp);
      if (!isAtOrAfter(timestamp, cutoffMs)) return;
      const date = jstDate(timestamp);
      if (date) {
        const amount = getGroup(groups, date, model, effort);
        amount.contexts += 1;
        updateSpan(amount, timestamp);
      }
      return;
    }
    if (row.type !== 'event_msg' || payload?.type !== 'token_count') return;
    const total = object(object(payload.info)?.total_token_usage);
    if (!total) return;
    const current = {
      input: nonNegative(total.input_tokens),
      cached: nonNegative(total.cached_input_tokens),
      output: nonNegative(total.output_tokens),
    };
    const deltaInput = monotonicDelta(current.input, previous.input);
    const deltaCached = monotonicDelta(current.cached, previous.cached);
    const deltaOutput = monotonicDelta(current.output, previous.output);
    previous = current;
    if (deltaInput === 0 && deltaCached === 0 && deltaOutput === 0) return;
    const timestamp = text(row.timestamp);
    if (!isAtOrAfter(timestamp, cutoffMs)) return;
    const date = jstDate(timestamp);
    if (!date) return;
    const amount = getGroup(groups, date, model, effort);
    amount.cachedInputTokens += deltaCached;
    amount.inputTokens += Math.max(deltaInput - deltaCached, 0);
    amount.outputTokens += deltaOutput;
    updateSpan(amount, timestamp);
  });

  return {
    provider: 'codex-cli',
    sessionId,
    records: finalizeGroups(path, sessionId, 'codex-cli', repoPath, groups),
  };
}

function finalizeGroups(
  sourcePath: string,
  sessionId: string,
  provider: LlmProvider,
  repoPath: string | null,
  groups: Map<string, MutableUsage>,
): UsageRecord[] {
  return [...groups.entries()].map(([key, amount]) => {
    const [usageDate, model, effort] = key.split('\u0000');
    amount.totalTokens = amount.inputTokens + amount.cachedInputTokens
      + amount.cacheWrite5mTokens + amount.cacheWrite1hTokens + amount.outputTokens;
    const cost = estimateEquivalentApiCost(provider, model, amount);
    amount.costUsd = cost.usd;
    amount.costBasis = cost.basis;
    return {
      sourcePath,
      sessionId,
      provider,
      usageDate,
      model,
      effort,
      repoPath,
      startedAt: amount.startedAt,
      endedAt: amount.endedAt,
      contexts: amount.contexts,
      inputTokens: amount.inputTokens,
      cachedInputTokens: amount.cachedInputTokens,
      cacheWrite5mTokens: amount.cacheWrite5mTokens,
      cacheWrite1hTokens: amount.cacheWrite1hTokens,
      outputTokens: amount.outputTokens,
      totalTokens: amount.totalTokens,
      costUsd: amount.costUsd,
      costBasis: amount.costBasis,
    };
  });
}

function getGroup(groups: Map<string, MutableUsage>, date: string, model: string, effort: string): MutableUsage {
  const key = `${date}\u0000${model}\u0000${effort}`;
  const existing = groups.get(key);
  if (existing) return existing;
  const created: MutableUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contexts: 0,
    costUsd: 0,
    costBasis: 'unpriced',
    startedAt: null,
    endedAt: null,
  };
  groups.set(key, created);
  return created;
}

async function forEachJsonLine(path: string, visit: (row: JsonObject) => void): Promise<void> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        const value: unknown = JSON.parse(line);
        const row = object(value);
        if (row) visit(row);
      } catch {
        // A provider can leave a partial final JSONL line while the session is active.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

function object(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null ? value as JsonObject : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function monotonicDelta(current: number, previous: number): number {
  return current >= previous ? current - previous : current;
}

function updateSpan(amount: MutableUsage, timestamp: string | null): void {
  if (!timestamp) return;
  if (!amount.startedAt || timestamp < amount.startedAt) amount.startedAt = timestamp;
  if (!amount.endedAt || timestamp > amount.endedAt) amount.endedAt = timestamp;
}

function isAtOrAfter(timestamp: string | null, cutoffMs: number): boolean {
  if (!timestamp) return false;
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) && time >= cutoffMs;
}

function jstDate(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(time));
}
