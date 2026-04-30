// Domain catalog — fetch each newly-seen domain's home page once, ask Sonnet
// to classify it (1-2 sentence description + short kind), and cache the
// result in the domain_catalog table. Re-checks are skipped while the row
// exists, so this runs lazily on /api/access pings.

import { parse as parseHtml } from 'node-html-parser';
import { runLlm } from './llm.js';

const SKIP_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|\[::1\])$/i;

export function shouldSkipDomain(domain) {
  if (!domain) return true;
  if (SKIP_HOST.test(domain)) return true;
  // Bare IPs (v4) and intranet-style hosts often 404; we still try them but
  // never localhost.
  return false;
}

const CLASSIFY_PROMPT = ({ domain, title, metaDescription, bodySample }) => [
  'あなたは Web サイトを辞書化する係です。次の情報からこのドメインを JSON 1 オブジェクトのみで出力してください (前置き不要、コードフェンス禁止)。',
  '',
  'スキーマ:',
  '{',
  '  "site_name": "サービス名 / プロダクト名 (例: GitHub, Notion, Cloudflare Dashboard)",',
  '  "description": "1〜2 文の概要 (50〜120 文字)",',
  '  "can_do": "このドメインで何ができるかを箇条書き 2〜4 個 (- で始める)。改行は \\n。",',
  '  "kind": "短いカテゴリ (例: ドキュメント, ブログ, SaaS, ニュース, ツール, 企業サイト, 個人サイト)"',
  '}',
  '',
  `Domain: ${domain}`,
  `Title: ${title}`,
  `Meta Description: ${metaDescription}`,
  '',
  'Body sample:',
  bodySample,
].join('\n');

/**
 * Fetch + classify a single domain. Returns one of:
 *   { skip: true }            — host blacklisted (e.g. localhost)
 *   { dropRow: true, ... }    — fetch failed in a way that means we should
 *                                forget about the domain (404, DNS error, etc.)
 *   { ok: true, ...fields }   — classification succeeded
 *   { ok: false, error }      — claude or HTML parse failed (keep row, mark error)
 */
export async function classifyDomain({ domain, timeoutMs = 60_000 }) {
  if (shouldSkipDomain(domain)) return { skip: true };

  let res;
  try {
    res = await fetch(`https://${domain}/`, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Memoria/0.2',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.9',
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { dropRow: true, error: `fetch: ${e.message}` };
  }

  if (res.status === 404 || !res.ok) {
    return { dropRow: true, error: `HTTP ${res.status}` };
  }

  const ct = res.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml/i.test(ct)) {
    return { ok: false, error: `non-html (${ct})` };
  }

  let html;
  try {
    html = await res.text();
  } catch (e) {
    return { ok: false, error: `body: ${e.message}` };
  }

  const root = parseHtml(html, { lowerCaseTagName: false });
  const title = root.querySelector('title')?.text?.replace(/\s+/g, ' ').trim().slice(0, 200) || '';
  const metaDescription = (
    root.querySelector('meta[name="description"]')?.getAttribute('content') ||
    root.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
    ''
  ).replace(/\s+/g, ' ').trim().slice(0, 400);

  root.querySelectorAll('script, style, noscript, svg, link, meta, iframe').forEach(n => n.remove());
  const bodySample = root.text.replace(/\s+/g, ' ').trim().slice(0, 2000);

  const prompt = CLASSIFY_PROMPT({ domain, title, metaDescription, bodySample });
  let parsed;
  try {
    const stdout = await runLlm({ task: 'domain_classify', prompt, timeoutMs });
    parsed = parseClassifyJson(stdout);
  } catch (e) {
    return { ok: false, error: `claude: ${e.message}`, title, metaDescription };
  }

  return {
    ok: true,
    title,
    site_name: parsed.site_name,
    description: parsed.description,
    can_do: parsed.can_do,
    kind: parsed.kind,
  };
}

function parseClassifyJson(raw) {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { throw new Error(`json parse: ${e.message}`); }
  return {
    site_name: String(obj.site_name ?? '').trim().slice(0, 120),
    description: String(obj.description ?? '').trim().slice(0, 400),
    can_do: String(obj.can_do ?? '').trim().slice(0, 600),
    kind: String(obj.kind ?? '').trim().slice(0, 40),
  };
}

