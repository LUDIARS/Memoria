import { assertPublicHttpUrl } from './public-url.js';

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export interface PublicFetchOptions {
  accept?: string;
  maxBytes?: number;
  userAgent?: string;
  extraHeaders?: Record<string, string>;
}

export interface PublicFetchResult {
  text: string;
  finalUrl: string;
  contentType: string;
}

function decodeText(bytes: Uint8Array, contentType: string): string {
  const prefix = new TextDecoder('latin1').decode(bytes.slice(0, 2_048));
  const headerCharset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
  const metaCharset = prefix.match(/<meta[^>]+charset\s*=\s*["']?([^"'\s/>]+)/i)?.[1]
    ?? prefix.match(/<\?xml[^>]+encoding=["']([^"']+)/i)?.[1];
  const charset = (headerCharset ?? metaCharset ?? 'utf-8').trim().toLowerCase();
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    throw new Error(`unsupported charset: ${charset}`);
  }
}

export async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel('response body exceeds configured limit'); } catch { /* already errored */ }
        throw new Error(`response too large: more than ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

async function discardBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* body already closed */ }
}

/**
 * 公開 http(s) URL のテキストを SSRF ガード付きで取得する (redirect は手動追跡し、 各 hop で再検証)。
 */
export async function fetchPublicText(initialUrl: string, options: PublicFetchOptions = {}): Promise<PublicFetchResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let currentUrl = initialUrl;
  const initialOrigin = new URL(initialUrl).origin;
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      await assertPublicHttpUrl(currentUrl);
      // extraHeaders は資格情報 (GitHub の Authorization 等) を含みうるので、
      // redirect で別 origin に移ったら引き継がない。
      const sameOrigin = new URL(currentUrl).origin === initialOrigin;
      const response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': options.userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MemoriaReleaseWatch/1.0',
          'Accept': options.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
          'Accept-Language': 'ja,en;q=0.8',
          ...(sameOrigin ? options.extraHeaders ?? {} : {}),
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await discardBody(response);
        if (!location) throw new Error(`redirect ${response.status} without location`);
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok) {
        await discardBody(response);
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await discardBody(response);
        throw new Error(`response too large: ${declared} bytes`);
      }
      const bytes = await readBoundedBytes(response, maxBytes);
      return { text: decodeText(bytes, contentType), finalUrl: currentUrl, contentType };
    }
    throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
  } finally {
    clearTimeout(timeout);
  }
}
