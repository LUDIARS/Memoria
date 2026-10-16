/** Read Concordia's observed subscription limits; never read credentials or infer limits from tokens. */
export interface LimitPoint {
  ts: number;
  provider: string;
  plan: string | null;
  used5hPct: number | null;
  usedWeeklyPct: number | null;
  reset5hAt: number | null;
  resetWeeklyAt: number | null;
}

const nullableNumber = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value));

export const REMAINING_RANGE_SECONDS = {
  '3m': 90 * 86400, '1m': 30 * 86400, '1w': 7 * 86400, '1d': 86400, '1h': 3600,
} as const;
export type RemainingRange = keyof typeof REMAINING_RANGE_SECONDS;

export function parseRemainingRange(value: string | undefined): RemainingRange {
  if (value === undefined) return '1w';
  if (Object.hasOwn(REMAINING_RANGE_SECONDS, value)) return value as RemainingRange;
  throw new RangeError('表示期間は 3m / 1m / 1w / 1d / 1h から選んでください');
}

export function parseRemainingStart(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > now) {
    throw new RangeError('開始日時は現在以前の日時を指定してください');
  }
  return parsed;
}

function isPoint(value: unknown): value is LimitPoint {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.ts === 'number' && Number.isFinite(row.ts) && row.ts > 0
    && typeof row.provider === 'string'
    && (row.plan === null || typeof row.plan === 'string')
    && ['used5hPct', 'usedWeeklyPct', 'reset5hAt', 'resetWeeklyAt'].every((key) => nullableNumber(row[key]));
}

export async function fetchRemainingUsage(deps: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  range?: RemainingRange;
  from?: number;
} = {}): Promise<{ points: LimitPoint[]; range: RemainingRange; from: number; to: number; now: number }> {
  const range = parseRemainingRange(deps.range);
  const now = Math.floor((deps.now ?? Date.now)() / 1000);
  const selectedStart = parseRemainingStart(deps.from === undefined ? undefined : String(deps.from), now);
  const from = selectedStart ?? now - REMAINING_RANGE_SECONDS[range];
  const to = from + REMAINING_RANGE_SECONDS[range];
  const base = deps.baseUrl ?? process.env.CONCORDIA_URL ?? process.env.MEMORIA_CONCORDIA_URL;
  if (!base) throw new Error('Concordia の接続先 (CONCORDIA_URL) が設定されていません');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Concordia の接続先の設定が不正です');
  }
  url.pathname = '/v1/cost/limit-timeseries';
  url.search = new URLSearchParams({ since: String(from) }).toString();
  url.hash = '';
  const response = await (deps.fetchImpl ?? fetch)(url, {
    signal: AbortSignal.timeout(8000), redirect: 'error', headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Concordia が応答できませんでした (HTTP ${response.status})`);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('points' in body) || !Array.isArray(body.points)
      || body.points.length > 100000 || !body.points.every(isPoint)) {
    throw new Error('Concordia の残量データの形式が不正です');
  }
  // Return only the chart contract, even if the upstream response gains private fields.
  return { range, from, to, now, points: body.points.filter((point) => point.ts >= from && point.ts <= Math.min(to, now))
    .map(({ ts, provider, plan, used5hPct, usedWeeklyPct, reset5hAt, resetWeeklyAt }) =>
    ({ ts, provider, plan, used5hPct, usedWeeklyPct, reset5hAt, resetWeeklyAt })) };
}
