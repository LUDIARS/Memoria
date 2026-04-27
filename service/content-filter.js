// Content filter — refuses bookmarks whose URL/title/body contain banned keywords.
//
// 機能:
//   1. NG ワード substring (case-insensitive)
//   2. NG ワード regex pattern (`re:` 接頭辞)
//   3. NG ドメイン (host suffix 一致)
//   4. ホワイトリストワード — マッチすると当該ブックマークは絶対 reject されない
//      (例: "アダルト水泳教室" を許容したい場合 "アダルト水泳教室" を whitelist に)
//
// 設定ファイル形式:
//   - 1 行 1 語、`#` でコメント、または JSON 配列
//   - 行頭 `re:` で続く文字列を JS 正規表現として解釈 (例: `re:^xxx[0-9]{3}$`)
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

const DEFAULT_WHITELIST = [
  // Common false positives — leave space for the user to extend.
];

let cached = null;

export function loadFilter({
  ngWordsFile = process.env.MEMORIA_NGWORDS_FILE,
  ngDomainsFile = process.env.MEMORIA_NG_DOMAINS_FILE,
  whitelistFile = process.env.MEMORIA_WHITELIST_FILE,
  enabled = process.env.MEMORIA_CONTENT_FILTER !== '0',
} = {}) {
  if (cached) return cached;

  const wordEntries = mergeEntries(DEFAULT_NG_WORDS, ngWordsFile);
  const wlEntries   = mergeEntries(DEFAULT_WHITELIST, whitelistFile);
  const domainSet   = new Set([...DEFAULT_NG_DOMAINS, ...readEntries(ngDomainsFile)]
    .map((d) => String(d).toLowerCase()));

  cached = {
    enabled,
    words:     buildPatterns(wordEntries),
    whitelist: buildPatterns(wlEntries),
    domains:   [...domainSet],
  };
  return cached;
}

/** Reset the cached filter — useful for tests / hot reload. */
export function resetFilterCache() { cached = null; }

function mergeEntries(defaults, file) {
  const out = [...defaults];
  for (const e of readEntries(file)) out.push(e);
  return out;
}

function readEntries(file) {
  if (!file || !existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8').trim();
  if (raw.startsWith('[')) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return raw.split(/\r?\n/).map((s) => s.replace(/#.*$/, '').trim()).filter(Boolean);
}

/**
 * Convert raw entries into a uniform shape:
 *   { type: 'substring', value: 'lowercased' }
 *   { type: 'regex', value: <RegExp>, raw: 're:...' }
 *
 * Regex entries are written as `re:<pattern>` and treated as case-insensitive.
 * Invalid regexes fall back to a literal substring (with the `re:` prefix
 * stripped) so a malformed config never silently disables a check.
 */
function buildPatterns(entries) {
  const out = [];
  for (const raw of entries) {
    const s = String(raw).trim();
    if (!s) continue;
    if (s.startsWith('re:')) {
      const body = s.slice(3);
      try {
        out.push({ type: 'regex', value: new RegExp(body, 'i'), raw: s });
        continue;
      } catch {
        // fall through — treat as substring
      }
    }
    out.push({ type: 'substring', value: s.toLowerCase() });
  }
  return out;
}

function patternMatches(p, lowerText) {
  if (p.type === 'regex') return p.value.test(lowerText);
  return lowerText.includes(p.value);
}

function patternLabel(p) {
  return p.type === 'regex' ? p.raw : p.value;
}

/**
 * Check a candidate bookmark for banned content.
 * Returns { ok: true } or { ok: false, reason, matches: [...] }.
 *
 * Whitelist takes precedence — a single whitelist hit anywhere in
 * URL/title/body causes the entire candidate to be accepted.
 */
export function checkContent({ url, title, html }) {
  const f = loadFilter();
  if (!f.enabled) return { ok: true };

  const haystackUrl   = (url ?? '').toLowerCase();
  const haystackTitle = (title ?? '').toLowerCase();
  const haystackBody  = typeof html === 'string' && html.length > 0
    ? quickText(html).slice(0, 30_000).toLowerCase()
    : '';

  // 1. Whitelist short-circuit.
  for (const wl of f.whitelist) {
    if (patternMatches(wl, haystackUrl) ||
        patternMatches(wl, haystackTitle) ||
        (haystackBody && patternMatches(wl, haystackBody))) {
      return { ok: true, whitelisted: patternLabel(wl) };
    }
  }

  // 2. Domain check (always, even if word patterns clean).
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const bad of f.domains) {
      if (host === bad || host.endsWith('.' + bad)) {
        return { ok: false, reason: 'blocked_domain', matches: [bad] };
      }
    }
  } catch { /* invalid URL — handled upstream */ }

  // 3. URL/title NG word scan.
  const matches = new Set();
  for (const p of f.words) {
    if (patternMatches(p, haystackUrl) || patternMatches(p, haystackTitle)) {
      matches.add(patternLabel(p));
    }
  }
  if (matches.size > 0) {
    return { ok: false, reason: 'ng_word_in_url_or_title', matches: [...matches] };
  }

  // 4. Body NG word scan.
  if (haystackBody) {
    for (const p of f.words) {
      if (patternMatches(p, haystackBody)) {
        matches.add(patternLabel(p));
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
    root.querySelectorAll('script, style, noscript').forEach((n) => n.remove());
    return root.text;
  } catch {
    return html.replace(/<[^>]+>/g, ' ');
  }
}
