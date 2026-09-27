export interface TabulaConnection { base: URL; browser: URL; local: boolean }

/** The service-owned catalog supplies the local endpoint; never guess a port. */
export function tabulaConnection(env: NodeJS.ProcessEnv = process.env): TabulaConnection {
  const mode = env.MEMORIA_TABULA_MODE ?? 'local';
  if (mode !== 'local' && mode !== 'shared') throw new Error('Invalid MEMORIA_TABULA_MODE');
  const local = mode === 'local';
  const raw = local ? env.MEMORIA_TABULA_URL : env.TABULA_URL;
  if (!raw) throw new Error(local ? 'MEMORIA_TABULA_URL is required from the service catalog' : 'TABULA_URL is required');
  const base = validateUrl(raw, local);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const browser = local ? new URL(base) : validateUrl(env.TABULA_PUBLIC_URL ?? '', false);
  if (local) browser.hash = 'workspace=local';
  return {base,browser,local};
}

export function tabulaHeaders(connection: TabulaConnection, purpose: 'read'|'import', env: NodeJS.ProcessEnv = process.env): Record<string,string> {
  if (connection.local) return {Origin:connection.base.origin};
  const token = purpose === 'read' ? env.TABULA_READ_TOKEN : env.TABULA_IMPORT_TOKEN;
  if (!token?.trim()) throw new Error(`Tabula ${purpose} token is required`);
  return {Authorization:`Bearer ${token.trim()}`};
}

function validateUrl(raw: string, local: boolean): URL {
  const url = new URL(raw);
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (local && !loopback) || (url.protocol==='http:' && !loopback)) throw new Error('Invalid Tabula endpoint');
  return url;
}
