// Domain catalog — fetch each newly-seen domain's home page once, ask Sonnet
// to classify it (1-2 sentence description + short kind), and cache the
// result in the domain_catalog table. Re-checks are skipped while the row
// exists, so this runs lazily on /api/access pings.

import { parse as parseHtml } from 'node-html-parser';
import { runLlm } from './llm.js';

const SKIP_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|\[::1\])$/i;

export function shouldSkipDomain(domain: string | null | undefined): boolean {
  if (!domain) return true;
  if (SKIP_HOST.test(domain)) return true;
  // Bare IPs (v4) and intranet-style hosts often 404; we still try them but
  // never localhost.
  return false;
}

interface ClassifyPromptArgs {
  domain: string;
  title: string;
  metaDescription: string;
  bodySample: string;
}

const CLASSIFY_PROMPT = ({ domain, title, metaDescription, bodySample }: ClassifyPromptArgs): string => [
  'あなたは Web サイトを辞書化する係です。次の情報からこのドメインを JSON 1 オブジェクトのみで出力してください (前置き不要、コードフェンス禁止)。',
  '',
  '**4 つのフィールドはすべて必須**。情報が乏しくても推測で埋めること (空文字列・null・"unknown" 禁止)。',
  '',
  'スキーマ:',
  '{',
  '  "site_name": "サービス名 / プロダクト名 (例: GitHub, Notion, Cloudflare Dashboard)。タイトルから判断できるならそれを使う。",',
  '  "description": "1〜2 文の概要 (50〜120 文字)",',
  '  "can_do": "このドメインで何ができるかを箇条書き 2〜4 個 (- で始める)。改行は \\n。実際の操作 (作成/閲覧/管理 等) を動詞で書く。",',
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

export type ClassifyDomainResult =
  | { skip: true }
  | { dropRow: true; error: string }
  | { ok: false; error: string; title?: string; metaDescription?: string }
  | {
      ok: true;
      title: string;
      site_name: string;
      description: string;
      can_do: string;
      kind: string;
    };

/**
 * Fetch + classify a single domain.
 */
export async function classifyDomain({
  domain,
  timeoutMs = 60_000,
}: {
  domain: string;
  timeoutMs?: number;
}): Promise<ClassifyDomainResult> {
  if (shouldSkipDomain(domain)) return { skip: true };

  let res: Response;
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
  } catch (e: unknown) {
    return { dropRow: true, error: `fetch: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (res.status === 404 || !res.ok) {
    return { dropRow: true, error: `HTTP ${res.status}` };
  }

  const ct = res.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml/i.test(ct)) {
    return { ok: false, error: `non-html (${ct})` };
  }

  let html: string;
  try {
    html = await res.text();
  } catch (e: unknown) {
    return { ok: false, error: `body: ${e instanceof Error ? e.message : String(e)}` };
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
  let parsed: { site_name: string; description: string; can_do: string; kind: string };
  try {
    const stdout = await runLlm({ task: 'domain_classify', prompt, timeoutMs });
    parsed = parseClassifyJson(stdout);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `claude: ${msg}`, title, metaDescription };
  }

  // Defensive fallbacks: if the LLM somehow returns blank fields, fall
  // back to derivable info from the page itself so the row is never
  // half-populated.
  const fallbackSiteName = (title.split(/[|·–—:-]/)[0] || domain).trim().slice(0, 120);
  return {
    ok: true,
    title,
    site_name: parsed.site_name || fallbackSiteName,
    description: parsed.description || metaDescription || `${domain} のサイト`,
    can_do: parsed.can_do || `- ${domain} のコンテンツを閲覧する`,
    kind: parsed.kind || 'Webサイト',
  };
}

function parseClassifyJson(raw: string): { site_name: string; description: string; can_do: string; kind: string } {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  let obj: { site_name?: unknown; description?: unknown; can_do?: unknown; kind?: unknown };
  try {
    obj = JSON.parse(text);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`json parse: ${msg}`);
  }
  return {
    site_name: String(obj.site_name ?? '').trim().slice(0, 120),
    description: String(obj.description ?? '').trim().slice(0, 400),
    can_do: String(obj.can_do ?? '').trim().slice(0, 600),
    kind: String(obj.kind ?? '').trim().slice(0, 40),
  };
}
