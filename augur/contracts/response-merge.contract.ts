// Contract for mergeResponse (spec/tasks/2026-09-29-llm-usage-cost-accuracy.md, C-2).
// Stream fragments and copied history are the same response: tokens take the
// larger snapshot and are never added, and the original file owns attribution.

type Response = Record<string, unknown> & {
  isOrigin: boolean; sessionId: string; agentId: string | null; familyId: string;
};

const FIELDS = [
  'inputTokens', 'cacheReadTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens', 'cacheWriteUnknownTokens', 'outputTokens',
];

export default {
  post: (result: Response, existing: Response, incoming: Response): true | string => {
    for (const field of FIELDS) {
      const expected = Math.max(Number(existing[field]), Number(incoming[field]));
      if (result[field] !== expected) return `${field} must be the max of both sightings`;
    }
    const owner = incoming.isOrigin && !existing.isOrigin ? incoming : existing;
    return (result.sessionId === owner.sessionId && result.agentId === owner.agentId
      && result.familyId === owner.familyId)
      || 'attribution must come from the original file';
  },
};
