import { basename, extname } from 'node:path';
import { forEachJsonLine, jstDate, nonNegative, object, text, timeMs, type JsonObject } from './jsonl.js';
import { mergeResponse } from './response-merge.js';
import type { ParsedUsageSource, UsageResponse, UsageTokens } from './types.js';

/** Claude Code writes placeholder assistant rows under this model; they are never billed. */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * Read one Claude Code session or subagent JSONL.
 *
 * Claude Code writes one row per streamed content block, each carrying the
 * message usage so far, so rows are folded by `message.id` into the final usage
 * (see mergeResponse). Rows with the same id in other files are copied history
 * and are deduplicated again when stored.
 */
export async function parseClaudeLog(path: string, cutoffMs: number): Promise<ParsedUsageSource> {
  const fileId = basename(path, extname(path));
  const responses = new Map<string, UsageResponse>();
  let repoPath: string | null = null;
  let sessionEffort = 'unknown';

  await forEachJsonLine(path, (row) => {
    repoPath = repoPath ?? text(row.cwd);
    // Effort set for the session applies to later turns; a per-turn override
    // applies only to the row that carries it.
    sessionEffort = text(row.effort) ?? sessionEffort;
    const message = object(row.message);
    const usage = object(message?.usage);
    if (!message || !usage) return;
    const model = text(message.model) ?? 'unknown';
    if (model === SYNTHETIC_MODEL) return;
    const timestamp = text(row.timestamp);
    const occurredMs = timeMs(timestamp);
    if (!timestamp || occurredMs === null) return;
    const sessionId = text(row.sessionId) ?? fileId;
    const agentId = row.isSidechain === true ? text(row.agentId) : null;
    const responseId = text(message.id) ?? text(row.requestId) ?? prefixed(sessionId, text(row.uuid));
    if (!responseId) return;
    const response: UsageResponse = {
      provider: 'claude-code',
      responseId,
      sessionId,
      agentId,
      familyId: sessionId,
      isOrigin: agentId ? fileId === `agent-${agentId}` : fileId === sessionId,
      sourcePath: path,
      occurredAt: timestamp,
      occurredMs,
      usageDate: jstDate(occurredMs),
      model,
      effort: text(row.perTurnEffort) ?? sessionEffort,
      repoPath,
      ...claudeTokens(usage),
    };
    const existing = responses.get(responseId);
    responses.set(responseId, existing ? mergeResponse(existing, response) : response);
  });

  return {
    provider: 'claude-code',
    sessionId: fileId,
    // The first fragment decides the window, so a response that began before the
    // cutoff is never counted as a partial newer response.
    responses: [...responses.values()].filter((response) => response.occurredMs >= cutoffMs),
  };
}

export function claudeTokens(usage: JsonObject): UsageTokens {
  const breakdown = object(usage.cache_creation);
  const write5m = breakdown ? nonNegative(breakdown.ephemeral_5m_input_tokens) : 0;
  const write1h = breakdown ? nonNegative(breakdown.ephemeral_1h_input_tokens) : 0;
  const writeTotal = Math.max(nonNegative(usage.cache_creation_input_tokens), write5m + write1h);
  return {
    inputTokens: nonNegative(usage.input_tokens),
    cacheReadTokens: nonNegative(usage.cache_read_input_tokens),
    cacheWrite5mTokens: write5m,
    cacheWrite1hTokens: write1h,
    // Keep writes without a TTL breakdown separate instead of assuming 5m.
    cacheWriteUnknownTokens: writeTotal - write5m - write1h,
    // Thinking is already part of output_tokens; there is no separate count to add.
    outputTokens: nonNegative(usage.output_tokens),
  };
}

function prefixed(sessionId: string, uuid: string | null): string | null {
  return uuid ? `${sessionId}:${uuid}` : null;
}
