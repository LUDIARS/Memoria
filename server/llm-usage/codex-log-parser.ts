import { basename, extname } from 'node:path';
import { forEachJsonLine, jstDate, nonNegative, object, text, timeMs } from './jsonl.js';
import type { ParsedUsageSource, UsageResponse } from './types.js';

interface CumulativeUsage { input: number; cached: number; output: number }

/**
 * Read one Codex rollout JSONL from `sessions/` or `archived_sessions/`.
 *
 * `token_count` events carry the session's cumulative usage; each increase is
 * one response. Its id is derived from the cumulative totals, so the same
 * rollout found again under `archived_sessions/` produces the same ids and is
 * deduplicated when stored instead of being counted twice.
 */
export async function parseCodexLog(path: string, cutoffMs: number): Promise<ParsedUsageSource> {
  let sessionId = basename(path, extname(path));
  let repoPath: string | null = null;
  let model = 'unknown';
  let effort = 'unknown';
  let previous: CumulativeUsage = { input: 0, cached: 0, output: 0 };
  const responses: UsageResponse[] = [];

  await forEachJsonLine(path, (row) => {
    const payload = object(row.payload);
    if (row.type === 'session_meta' && payload) {
      sessionId = text(payload.id) ?? sessionId;
      repoPath = text(payload.cwd) ?? repoPath;
      return;
    }
    if (row.type === 'turn_context' && payload) {
      model = text(payload.model) ?? model;
      // Codex records the effort chosen for each turn in its turn_context.
      effort = text(payload.effort) ?? text(payload.reasoning_effort) ?? effort;
      repoPath = text(payload.cwd) ?? repoPath;
      return;
    }
    if (row.type !== 'event_msg' || payload?.type !== 'token_count') return;
    const total = object(object(payload.info)?.total_token_usage);
    if (!total) return;
    const current: CumulativeUsage = {
      input: nonNegative(total.input_tokens),
      cached: nonNegative(total.cached_input_tokens),
      // Includes reasoning_output_tokens; never add those again.
      output: nonNegative(total.output_tokens),
    };
    const deltaInput = monotonicDelta(current.input, previous.input);
    const deltaCached = monotonicDelta(current.cached, previous.cached);
    const deltaOutput = monotonicDelta(current.output, previous.output);
    previous = current;
    if (deltaInput === 0 && deltaCached === 0 && deltaOutput === 0) return;
    const timestamp = text(row.timestamp);
    const occurredMs = timeMs(timestamp);
    if (!timestamp || occurredMs === null || occurredMs < cutoffMs) return;
    responses.push({
      provider: 'codex-cli',
      responseId: `${sessionId}:${current.input}:${current.cached}:${current.output}`,
      sessionId,
      agentId: null,
      familyId: sessionId,
      isOrigin: true,
      sourcePath: path,
      occurredAt: timestamp,
      occurredMs,
      usageDate: jstDate(occurredMs),
      model,
      effort,
      repoPath,
      // Codex input_tokens includes the cached part.
      inputTokens: Math.max(deltaInput - deltaCached, 0),
      cacheReadTokens: deltaCached,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheWriteUnknownTokens: 0,
      outputTokens: deltaOutput,
    });
  });

  return { provider: 'codex-cli', sessionId, responses };
}

/** A cumulative counter that went backwards was reset, so its value is the new usage. */
function monotonicDelta(current: number, previous: number): number {
  return current >= previous ? current - previous : current;
}
