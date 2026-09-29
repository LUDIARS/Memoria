import type { UsageResponse, UsageTokens } from './types.js';

const TOKEN_FIELDS: ReadonlyArray<keyof UsageTokens> = [
  'inputTokens',
  'cacheReadTokens',
  'cacheWrite5mTokens',
  'cacheWrite1hTokens',
  'cacheWriteUnknownTokens',
  'outputTokens',
];

/**
 * Combine two sightings of the same provider response.
 *
 * - Stream fragments of one Claude message repeat the prompt usage and carry a
 *   growing cumulative `output_tokens`, so each field keeps its maximum: the
 *   final usage wins and nothing is added twice.
 * - Copied history (resume / fork / archive) repeats the same response in
 *   another file; the original file's attribution wins so parent / child /
 *   family ownership does not depend on which file sync read first.
 */
export function mergeResponse(existing: UsageResponse, incoming: UsageResponse): UsageResponse {
  const merged: UsageResponse = { ...existing };
  for (const field of TOKEN_FIELDS) merged[field] = Math.max(existing[field], incoming[field]);
  if (incoming.occurredMs < existing.occurredMs) {
    merged.occurredMs = incoming.occurredMs;
    merged.occurredAt = incoming.occurredAt;
    merged.usageDate = incoming.usageDate;
  }
  if (incoming.isOrigin && !existing.isOrigin) {
    merged.sessionId = incoming.sessionId;
    merged.agentId = incoming.agentId;
    merged.familyId = incoming.familyId;
    merged.sourcePath = incoming.sourcePath;
    merged.repoPath = incoming.repoPath ?? existing.repoPath;
    merged.isOrigin = true;
  } else {
    merged.repoPath = existing.repoPath ?? incoming.repoPath;
  }
  if (existing.model === 'unknown') merged.model = incoming.model;
  if (existing.effort === 'unknown') merged.effort = incoming.effort;
  return merged;
}
