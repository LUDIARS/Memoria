// Actio owns task data. Connection failures must never select the archived SQLite store.
export class ActioError extends Error {
  constructor(public readonly status: number) {
    super(`Actio task API returned HTTP ${status}`);
  }
}

export async function requestActio<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const configured = process.env.ACTIO_URL;
  if (!configured) throw new Error('ACTIO_URL is required (provided by the Actio Excubitor catalog)');
  const base = new URL(configured);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('ACTIO_URL must be an HTTP(S) service URL without credentials');
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (process.env.ACTIO_API_TOKEN) headers.Authorization = `Bearer ${process.env.ACTIO_API_TOKEN}`;
  const response = await fetch(new URL(path, base), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  if (!response.ok) throw new ActioError(response.status);
  return await response.json() as T;
}
