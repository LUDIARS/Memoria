// Per-URL page metadata — fetch the URL once, parse <title> + meta tags
// + Open Graph, then ask Sonnet for a 1-2 sentence summary of "what this
// specific page is". Cached forever in page_metadata; 404 / DNS errors
// drop the row so it can be retried later.

import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import { shouldSkipDomain } from './domain-catalog.js';
import { runLlm } from './llm.js';

interface PromptArgs {
  url: string;
  title: string;
  metaDescription: string;
  ogTitle: string;
  ogDescription: string;
  ogType: string;
  headers: string;
  bodySample: string;
}

const SUMMARY_PROMPT = ({ url, title, metaDescription, ogTitle, ogDescription, ogType, headers, bodySample }: PromptArgs): string => [
  'あなたは Web ページのメタ情報をもとに、「このページは何か」を 1〜2 文の日本語で説明する係です。',
  'JSON 1 オブジェクトのみで出力してください。前置き不要、コードフェンス禁止。',
  '',
  'スキーマ:',
  '{',
  '  "summary": "1〜2 文の説明 (40〜120 文字)",',
  '  "kind": "短いカテゴリ (例: 記事, ドキュメント, 検索結果, ダッシュボード, リポジトリ, SNS投稿, 動画, 商品ページ, etc.)"',
  '}',
  '',
  `URL: ${url}`,
  `Title: ${title || '(none)'}`,
  `Meta Description: ${metaDescription || '(none)'}`,
  `OG Title: ${ogTitle || '(none)'}`,
  `OG Description: ${ogDescription || '(none)'}`,
  `OG Type: ${ogType || '(none)'}`,
  `HTTP Headers (selected): ${headers}`,
  '',
  'Body sample:',
  bodySample,
].join('\n');

export type PageMetadataFetchResult =
  | { skip: true }
  | { dropRow: true; error: string }
  | {
      ok: false;
      http_status?: number;
      content_type?: string;
      title?: string;
      meta_description?: string;
      og_title?: string;
      og_description?: string;
      og_image?: string;
      og_type?: string;
      error: string;
    }
  | {
      ok: true;
      http_status: number;
      content_type: string;
      title: string;
      meta_description?: string;
      og_title?: string;
      og_description?: string;
      og_image?: string;
      og_type?: string;
      summary: string;
      kind: string;
    };

export async function fetchPageMetadata({
  url,
  timeoutMs = 60_000,
}: {
  url: string;
  timeoutMs?: number;
}): Promise<PageMetadataFetchResult> {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { dropRow: true, error: 'invalid url' };
  }
  if (shouldSkipDomain(host)) return { skip: true };

  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Memoria/0.2',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.9',
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e: unknown) {
    return { dropRow: true, error: `fetch: ${e instanceof Error ? e.message : String(e)}` };
  }

  const httpStatus = res.status;
  if (res.status === 404 || res.status >= 500) {
    return { dropRow: true, error: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    // 4xx other than 404: keep a stub so we don't retry every page load.
    return { ok: false, http_status: httpStatus, error: `HTTP ${res.status}` };
  }

  const contentType = res.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml/i.test(contentType)) {
    return {
      ok: true,
      http_status: httpStatus,
      content_type: contentType,
      title: '',
      summary: `HTML 以外のレスポンス (${contentType})`,
      kind: 'asset',
    };
  }

  let html: string;
  try {
    html = await res.text();
  } catch (e: unknown) {
    return {
      ok: false,
      http_status: httpStatus,
      content_type: contentType,
      error: `body: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const root = parseHtml(html, { lowerCaseTagName: false });
  const title = (root.querySelector('title')?.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const metaDescription = pickMeta(root, ['meta[name="description"]', 'meta[name="Description"]']);
  const ogTitle = pickMeta(root, ['meta[property="og:title"]']);
  const ogDescription = pickMeta(root, ['meta[property="og:description"]']);
  const ogImage = pickMeta(root, ['meta[property="og:image"]']);
  const ogType = pickMeta(root, ['meta[property="og:type"]']);

  root.querySelectorAll('script, style, noscript, svg, link, meta, iframe').forEach(n => n.remove());
  const bodySample = root.text.replace(/\s+/g, ' ').trim().slice(0, 2000);

  const interestingHeaders = [
    `content-type: ${contentType}`,
    `server: ${res.headers.get('server') || ''}`,
    `x-frame-options: ${res.headers.get('x-frame-options') || ''}`,
  ].filter(Boolean).join(' | ');

  const promptText = SUMMARY_PROMPT({
    url, title, metaDescription, ogTitle, ogDescription, ogType,
    headers: interestingHeaders, bodySample,
  });
  let parsed: { summary: string; kind: string };
  try {
    const stdout = await runLlm({ task: 'page_summary', prompt: promptText, timeoutMs });
    parsed = parseSummaryJson(stdout);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false, http_status: httpStatus, content_type: contentType,
      title, meta_description: metaDescription, og_title: ogTitle,
      og_description: ogDescription, og_image: ogImage, og_type: ogType,
      error: `claude: ${msg}`,
    };
  }

  return {
    ok: true,
    http_status: httpStatus,
    content_type: contentType,
    title,
    meta_description: metaDescription,
    og_title: ogTitle,
    og_description: ogDescription,
    og_image: ogImage,
    og_type: ogType,
    summary: parsed.summary,
    kind: parsed.kind,
  };
}

function pickMeta(root: HTMLElement, selectors: string[]): string {
  for (const sel of selectors) {
    const v = root.querySelector(sel)?.getAttribute('content');
    if (v) return v.replace(/\s+/g, ' ').trim().slice(0, 500);
  }
  return '';
}

function parseSummaryJson(raw: string): { summary: string; kind: string } {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  let obj: { summary?: unknown; kind?: unknown };
  try {
    obj = JSON.parse(text);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`json parse: ${msg}`);
  }
  return {
    summary: String(obj.summary ?? '').trim().slice(0, 400),
    kind: String(obj.kind ?? '').trim().slice(0, 40),
  };
}
