// URL preview = OG metadata fetcher for Notion 風 ad-hoc bookmark cards。
// LLM は呼ばない (= domain-catalog のように分類しない、 OG タグそのまま)。
//
// 使い所:
//   - /api/notes/url-preview からの request (note editor 内の「URL を埋め込む」)
//   - extension の Notion bookmark block 抽出後の補完 (caption が空の場合)

import { parse as parseHtml } from 'node-html-parser';

export interface UrlPreviewResult {
  ok: boolean;
  url: string;
  title: string;
  description: string;
  image: string | null;
  site_name: string | null;
  error?: string;
}

const FETCH_TIMEOUT_MS = 12_000;
const HTML_BYTE_LIMIT = 512 * 1024; // 512 KiB

export async function fetchUrlPreview(rawUrl: string): Promise<UrlPreviewResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, url: rawUrl, title: '', description: '', image: null, site_name: null, error: 'invalid url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, url: rawUrl, title: '', description: '', image: null, site_name: null, error: 'protocol not allowed' };
  }
  // 内部ホスト / loopback は弾く (server-side fetch なので SSRF 対策)
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    /^(127\.|0\.0\.0\.0|::1$|\[::1\]|169\.254\.)/i.test(host) ||
    /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/i.test(host)
  ) {
    return { ok: false, url: rawUrl, title: '', description: '', image: null, site_name: null, error: 'private/loopback host blocked' };
  }

  let res: Response;
  try {
    res = await fetch(parsed.toString(), {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Memoria/0.2',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.9',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e: unknown) {
    return {
      ok: false, url: rawUrl, title: '', description: '', image: null, site_name: null,
      error: `fetch: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!res.ok) {
    return {
      ok: false, url: rawUrl, title: '', description: '', image: null, site_name: null,
      error: `HTTP ${res.status}`,
    };
  }
  const ct = res.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml/i.test(ct)) {
    return {
      ok: false, url: rawUrl, title: '', description: '', image: null, site_name: null,
      error: `non-html (${ct})`,
    };
  }

  // body は size cap 付きで読む
  let html: string;
  try {
    const reader = res.body?.getReader();
    if (!reader) {
      html = await res.text();
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > HTML_BYTE_LIMIT) { reader.cancel().catch(() => {}); break; }
          chunks.push(value);
        }
      }
      html = new TextDecoder('utf-8', { fatal: false }).decode(concatChunks(chunks));
    }
  } catch (e: unknown) {
    return {
      ok: false, url: rawUrl, title: '', description: '', image: null, site_name: null,
      error: `body: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const root = parseHtml(html, { lowerCaseTagName: false });
  const meta = (sel: string): string =>
    (root.querySelector(sel)?.getAttribute('content') ?? '').trim();

  const ogTitle = meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]');
  const titleTag = root.querySelector('title')?.text?.replace(/\s+/g, ' ').trim() ?? '';
  const title = (ogTitle || titleTag).slice(0, 200);

  const description = (
    meta('meta[property="og:description"]') ||
    meta('meta[name="twitter:description"]') ||
    meta('meta[name="description"]') ||
    ''
  ).replace(/\s+/g, ' ').trim().slice(0, 400);

  const ogImage =
    meta('meta[property="og:image"]') ||
    meta('meta[name="twitter:image"]') ||
    meta('meta[name="twitter:image:src"]') ||
    '';
  const image = ogImage ? toAbsoluteUrl(ogImage, parsed) : null;

  const siteName =
    meta('meta[property="og:site_name"]') ||
    meta('meta[name="application-name"]') ||
    parsed.hostname;

  return {
    ok: true,
    url: parsed.toString(),
    title,
    description,
    image,
    site_name: siteName,
  };
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function toAbsoluteUrl(maybeRelative: string, base: URL): string | null {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}
