// Content filter — refuses bookmarks whose URL/title/body contain banned keywords.
// Hardcoded defaults can be overridden via MEMORIA_NGWORDS_FILE (newline / JSON
// array). Domain blocklist similarly via MEMORIA_NG_DOMAINS_FILE.
//
// We intentionally keep this simple — it's a courtesy filter for a personal
// tool, not a content moderation system. R18 detection is best-effort.

import { readFileSync, existsSync } from 'node:fs';
import { parse as parseHtml } from 'node-html-parser';

const DEFAULT_NG_WORDS = [
  // Adult / R18 (lower-case, substring match against lower-cased text)
  'porn', 'pornhub', 'xvideos', 'xnxx', 'redtube', 'youporn',
  'onlyfans', 'sex.com', 'r18', 'r-18', 'adult-only',
  'アダルト', '成人向け', 'エロ動画', 'エロ漫画', 'エッチ',
  // Illegal substance trafficking — keep conservative, expand via env file
  'cp porn', 'child porn',
];

const DEFAULT_NG_DOMAINS = [
  'pornhub.com', 'xvideos.com', 'xnxx.com', 'redtube.com', 'youporn.com',
  'onlyfans.com',
];

let cached = null;

export function loadFilter({
  ngWordsFile = process.env.MEMORIA_NGWORDS_FILE,
  ngDomainsFile = process.env.MEMORIA_NG_DOMAINS_FILE,
  enabled = process.env.MEMORIA_CONTENT_FILTER !== '0',
} = {}) {
  if (cached) return cached;
  const words = new Set(DEFAULT_NG_WORDS.map(w => w.toLowerCase()));
  const domains = new Set(DEFAULT_NG_DOMAINS.map(d => d.toLowerCase()));

  if (ngWordsFile && existsSync(ngWordsFile)) {
    for (const w of parseListFile(ngWordsFile)) {
      words.add(w.toLowerCase());
    }
  }
  if (ngDomainsFile && existsSync(ngDomainsFile)) {
    for (const d of parseListFile(ngDomainsFile)) {
      domains.add(d.toLowerCase());
    }
  }
  cached = { enabled, words: [...words], domains: [...domains] };
  return cached;
}

function parseListFile(path) {
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.startsWith('[')) {
    try { return JSON.parse(raw); } catch {}
  }
  return raw.split(/\r?\n/).map(s => s.replace(/#.*$/, '').trim()).filter(Boolean);
}

/**
 * Check a candidate bookmark for banned content.
 * Returns { ok: true } or { ok: false, reason, matches: [...] }.
 */
export function checkContent({ url, title, html }) {
  const f = loadFilter();
  if (!f.enabled) return { ok: true };

  // 1. URL/domain check
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const bad of f.domains) {
      if (host === bad || host.endsWith('.' + bad)) {
        return { ok: false, reason: 'blocked_domain', matches: [bad] };
      }
    }
  } catch {}

  const haystackUrl = (url ?? '').toLowerCase();
  const haystackTitle = (title ?? '').toLowerCase();
  const matches = new Set();
  for (const w of f.words) {
    if (haystackUrl.includes(w) || haystackTitle.includes(w)) {
      matches.add(w);
    }
  }
  if (matches.size > 0) {
    return { ok: false, reason: 'ng_word_in_url_or_title', matches: [...matches] };
  }

  // 2. Body text check (extract once, scan once)
  if (typeof html === 'string' && html.length > 0) {
    const text = quickText(html).slice(0, 30_000).toLowerCase();
    for (const w of f.words) {
      if (text.includes(w)) {
        matches.add(w);
        if (matches.size >= 5) break;
      }
    }
    if (matches.size > 0) {
      return { ok: false, reason: 'ng_word_in_body', matches: [...matches] };
    }
  }

  return { ok: true };
}

function quickText(html) {
  try {
    const root = parseHtml(html);
    root.querySelectorAll('script, style, noscript').forEach(n => n.remove());
    return root.text;
  } catch {
    return html.replace(/<[^>]+>/g, ' ');
  }
}
