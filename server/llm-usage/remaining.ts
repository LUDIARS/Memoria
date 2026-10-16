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
} = {}): Promise<{ points: LimitPoint[] }> {
  const base = deps.baseUrl ?? process.env.CONCORDIA_URL ?? process.env.MEMORIA_CONCORDIA_URL;
  if (!base) throw new Error('Concordia の接続先 (CONCORDIA_URL) が設定されていません');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Concordia の接続先の設定が不正です');
  }
  url.pathname = '/v1/cost/limit-timeseries';
  url.search = new URLSearchParams({ since: String(Math.floor((deps.now ?? Date.now)() / 1000) - 7 * 86400) }).toString();
  url.hash = '';
  const response = await (deps.fetchImpl ?? fetch)(url, {
    signal: AbortSignal.timeout(8000), redirect: 'error', headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Concordia が応答できませんでした (HTTP ${response.status})`);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('points' in body) || !Array.isArray(body.points)
      || body.points.length > 10000 || !body.points.every(isPoint)) {
    throw new Error('Concordia の残量データの形式が不正です');
  }
  // Return only the chart contract, even if the upstream response gains private fields.
  return { points: body.points.map(({ ts, provider, plan, used5hPct, usedWeeklyPct, reset5hAt, resetWeeklyAt }) =>
    ({ ts, provider, plan, used5hPct, usedWeeklyPct, reset5hAt, resetWeeklyAt })) };
}
