// Fast SERP scrape — runs BEFORE any LLM call so the user sees Google-style
// search hits within a couple of seconds, while the AI preview / deep dig
// keep cooking in the background.

import { parse as parseHtml } from 'node-html-parser';

const DEFAULT_TIMEOUT_MS = 12_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0 Safari/537.36';

export interface SerpResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

export interface SerpResponse {
  engine: 'duckduckgo' | 'bing';
  results: SerpResult[];
  fetched_at: string;            // UTC ISO
}

type EngineName = 'duckduckgo' | 'bing';

const ENGINES: Record<EngineName, (q: string, signal: AbortSignal) => Promise<SerpResult[]>> = {
  duckduckgo: scrapeDuckDuckGo,
  bing: scrapeBing,
};

export async function runDigRawSerp({
  query,
  searchEngine = 'default',
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  query: string;
  searchEngine?: string;
  timeoutMs?: number;
}): Promise<SerpResponse | null> {
  if (!query) return null;
  const order = engineOrder(searchEngine);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    for (const name of order) {
      const fn = ENGINES[name];
      if (!fn) continue;
      try {
        const results = await fn(query, ac.signal);
        if (results && results.length) {
          return {
            engine: name,
            results: results.slice(0, 10),
            fetched_at: new Date().toISOString(),
          };
        }
      } catch {
        if (ac.signal.aborted) break;
        // try the next engine
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function engineOrder(searchEngine: string): EngineName[] {
  if (searchEngine === 'bing') return ['bing', 'duckduckgo'];
  return ['duckduckgo', 'bing'];
}

async function scrapeDuckDuckGo(query: string, signal: AbortSignal): Promise<SerpResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html',
      'Accept-Language': 'ja,en;q=0.7',
    },
  });
  if (!res.ok) throw new Error(`ddg ${res.status}`);
  const html = await res.text();
  const root = parseHtml(html);
  const out: SerpResult[] = [];
  for (const r of root.querySelectorAll('.result')) {
    const a = r.querySelector('.result__title a, a.result__a');
    if (!a) continue;
    const rawHref = a.getAttribute('href') || '';
    const title = a.text.trim();
    const snippet = (r.querySelector('.result__snippet')?.text || '').trim();
    const finalUrl = unwrapDuckDuckGoLink(rawHref);
    if (!/^https?:\/\//.test(finalUrl)) continue;
    if (!title) continue;
    out.push({
      title,
      url: finalUrl,
      snippet: snippet.slice(0, 600),
      domain: extractDomain(finalUrl),
    });
    if (out.length >= 10) break;
  }
  return out;
}

function unwrapDuckDuckGoLink(href: string): string {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    if (u.pathname === '/l/' && u.searchParams.has('uddg')) {
      return decodeURIComponent(u.searchParams.get('uddg') || '');
    }
    return u.toString();
  } catch {
    return href;
  }
}

async function scrapeBing(query: string, signal: AbortSignal): Promise<SerpResult[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&form=QBLH`;
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html',
      'Accept-Language': 'ja,en;q=0.7',
    },
  });
  if (!res.ok) throw new Error(`bing ${res.status}`);
  const html = await res.text();
  const root = parseHtml(html);
  const out: SerpResult[] = [];
  for (const li of root.querySelectorAll('#b_results > li.b_algo')) {
    const a = li.querySelector('h2 a');
    if (!a) continue;
    const href = a.getAttribute('href') || '';
    if (!/^https?:\/\//.test(href)) continue;
    const title = a.text.trim();
    const snippetEl = li.querySelector('.b_caption p, .b_caption .b_lineclamp4, .b_dList li');
    const snippet = (snippetEl?.text || '').trim();
    if (!title) continue;
    out.push({
      title,
      url: href,
      snippet: snippet.slice(0, 600),
      domain: extractDomain(href),
    });
    if (out.length >= 10) break;
  }
  return out;
}

function extractDomain(url: string): string {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}
