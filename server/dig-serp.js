// Fast SERP scrape — runs BEFORE any LLM call so the user sees Google-style
// search hits within a couple of seconds, while the AI preview / deep dig
// keep cooking in the background.
//
// We hit DuckDuckGo's HTML-only endpoint (`html.duckduckgo.com/html/`) by
// default because it has stable markup, doesn't require an API key, doesn't
// run JS, and is the most scrape-friendly mainstream engine. Bing also
// works but its markup churns more often. Google is hostile to scraping
// (captcha) so we skip it from this path — users who picked "Google" still
// get Google via the existing Claude-driven phases.
//
// One module-level fetch with a 12s budget; if it fails we just return
// `null` and the UI falls through to the Claude preview.

import { parse as parseHtml } from 'node-html-parser';

const DEFAULT_TIMEOUT_MS = 12_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0 Safari/537.36';

const ENGINES = {
  duckduckgo: scrapeDuckDuckGo,
  bing: scrapeBing,
  // Google / Brave fall back to DuckDuckGo for the raw stage.
};

/**
 * Fetch a SERP and return up to 10 raw results as fast as possible. No AI,
 * no per-page fetch — just the search engine's snippet layer.
 *
 * Returns `{ engine, results: [{title, url, snippet, domain}], fetched_at }`
 * or `null` if every attempt failed (timeout / blocked / parse error). The
 * caller should treat null as "no fast results, wait for the AI preview".
 */
export async function runDigRawSerp({ query, searchEngine = 'default', timeoutMs = DEFAULT_TIMEOUT_MS }) {
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
      } catch (e) {
        if (ac.signal.aborted) break;
        // try the next engine
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function engineOrder(searchEngine) {
  // DuckDuckGo first by default. If the user picked a specific engine and we
  // have a scraper for it, try that first.
  if (searchEngine === 'bing') return ['bing', 'duckduckgo'];
  return ['duckduckgo', 'bing'];
}

async function scrapeDuckDuckGo(query, signal) {
  // The `html.duckduckgo.com` endpoint serves a JS-free results page that's
  // the documented "scraping-allowed" surface for non-API consumers.
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
  const out = [];
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

function unwrapDuckDuckGoLink(href) {
  // DuckDuckGo wraps outbound links: `//duckduckgo.com/l/?uddg=<encoded>&...`
  // Sometimes returns a relative URL. Decode if present, else use as-is.
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    if (u.pathname === '/l/' && u.searchParams.has('uddg')) {
      return decodeURIComponent(u.searchParams.get('uddg'));
    }
    return u.toString();
  } catch {
    return href;
  }
}

async function scrapeBing(query, signal) {
  // Bing has stable enough markup for the top 10 organic links. Skip ad
  // blocks (`b_ad`) which sometimes appear above the fold.
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
  const out = [];
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

function extractDomain(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; }
}
