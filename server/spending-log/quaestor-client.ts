import {
  QuaestorSpendingLogExportSchema,
  type QuaestorSpendingLogExport,
} from './contract.js';

export interface SpendingLogRange {
  dateFrom: string;
  dateTo: string;
}

export async function fetchQuaestorSpendingLogs(
  baseUrl: string,
  range: SpendingLogRange,
  fetchImpl: typeof fetch = fetch,
): Promise<QuaestorSpendingLogExport> {
  const base = parseLoopbackBaseUrl(baseUrl);
  const url = new URL('/v1/integrations/memoria/spending-logs', base);
  url.searchParams.set('date_from', range.dateFrom);
  url.searchParams.set('date_to', range.dateTo);

  const response = await fetchImpl(url, {
    // loopback 制約を redirect で迂回させない。 GET でも支出ログ取得先を外へ出さない。
    redirect: 'error',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Quaestor spending-log export failed (${response.status}): ${detail}`);
  }
  return QuaestorSpendingLogExportSchema.parse(await response.json());
}

function parseLoopbackBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('QUAESTOR_URL must be an absolute URL supplied by Excubitor');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('QUAESTOR_URL must use http or https');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost'
    || hostname === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (!loopback) {
    throw new Error('QUAESTOR_URL must point to a loopback address for sensitive-log sync');
  }
  return url;
}
