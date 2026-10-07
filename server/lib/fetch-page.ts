// HTML を fetch して title と本文を返す。 ブクマ from-url / multi/download / visits/bookmark で共有。
import { fetchPublicText } from '../shared/public-fetch.js';

export interface FetchedPageHtml {
  html: string;
  title: string;
}

export async function fetchPageHtml(url: string, timeoutMs = 30_000): Promise<FetchedPageHtml> {
  const res = await fetchPublicText(url, { timeoutMs });
  const ct = res.contentType;
  if (!/text\/html|application\/xhtml/i.test(ct)) {
    throw new Error(`unsupported content-type: ${ct}`);
  }
  const html = res.text;
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = m ? decodeHtmlEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
  return { html, title };
}

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
