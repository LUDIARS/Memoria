import { assertPublicHttpUrl } from '../shared/public-url.js';
import { parseShoppingOffers } from './parser.js';
import type { ShoppingOffer, ShoppingSource } from './types.js';

const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const prefix = new TextDecoder('latin1').decode(bytes.slice(0, 2_048));
  const headerCharset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
  const metaCharset = prefix.match(/<meta[^>]+charset\s*=\s*["']?([^"'\s/>]+)/i)?.[1]
    ?? prefix.match(/<meta[^>]+content=["'][^"']*charset=([^;"'\s]+)/i)?.[1];
  const charset = (headerCharset ?? metaCharset ?? 'utf-8').trim().toLowerCase();
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    throw new Error(`unsupported charset: ${charset}`);
  }
}

export async function readResponseBytes(response: Response, maxBytes = MAX_HTML_BYTES): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel('response body exceeds configured limit');
        } catch {
          // The remote stream may already be errored; the size violation remains the primary failure.
        }
        throw new Error(`page too large: more than ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be closed or errored; there is no remaining response data to consume.
  }
}

async function fetchPublicHtml(initialUrl: string): Promise<{ html: string; finalUrl: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let currentUrl = initialUrl;
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      await assertPublicHttpUrl(currentUrl);
      const response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36 MemoriaShoppingCrawler/1.0',
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'Accept-Language': 'ja,en;q=0.8',
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await cancelResponseBody(response);
        if (!location) throw new Error(`redirect ${response.status} without location`);
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
        await cancelResponseBody(response);
        throw new Error(`unsupported content-type: ${contentType}`);
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_HTML_BYTES) {
        await cancelResponseBody(response);
        throw new Error(`page too large: ${declaredLength} bytes`);
      }
      const bytes = await readResponseBytes(response);
      return { html: decodeHtml(bytes, contentType), finalUrl: currentUrl };
    }
    throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
  } finally {
    clearTimeout(timeout);
  }
}

function crawlUrl(source: ShoppingSource, query?: string): string {
  if (!query || source.searchUrlTemplate === null) return source.pageUrl;
  return source.searchUrlTemplate.replaceAll('{query}', encodeURIComponent(query));
}

export async function crawlShoppingSource(source: ShoppingSource, query?: string): Promise<ShoppingOffer[]> {
  const url = crawlUrl(source, query);
  const page = await fetchPublicHtml(url);
  return parseShoppingOffers(page.html, source, page.finalUrl, { query });
}
