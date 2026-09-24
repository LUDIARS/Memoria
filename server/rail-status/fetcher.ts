import { parseKantoPage } from './parser.js';
import { SOURCE_URL, type RailData } from './types.js';
const MAX_BYTES = 2 * 1024 * 1024;

/** Fetch the one fixed public page with bounded time and size. Never follow a login/redirect response. */
export async function fetchKantoPage(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<RailData> {
  const response = await fetcher(SOURCE_URL, { redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { 'User-Agent': 'Memoria-RailStatus/1.0', Accept: 'text/html' } });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('source_unavailable');
  if (!response.body) throw new Error('empty_source');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw new Error('source_too_large');
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return parseKantoPage(Buffer.concat(chunks).toString('utf8'));
}
