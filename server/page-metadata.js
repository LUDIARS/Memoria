// Per-URL page metadata — fetch the URL once, parse <title> + meta tags
// + Open Graph, then ask Sonnet for a 1-2 sentence summary of "what this
// specific page is". Cached forever in page_metadata; 404 / DNS errors
// drop the row so it can be retried later.

import { spawn } from 'node:child_process';
import { parse as parseHtml } from 'node-html-parser';
import { shouldSkipDomain } from './domain-catalog.js';

const SUMMARY_PROMPT = ({ url, title, metaDescription, ogTitle, ogDescription, ogType, headers, bodySample }) => [
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

export async function fetchPageMetadata({ url, claudeBin = 'claude', timeoutMs = 60_000 }) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); }
  catch { return { dropRow: true, error: 'invalid url' }; }
  if (shouldSkipDomain(host)) return { skip: true };

  let res;
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
  } catch (e) {
    return { dropRow: true, error: `fetch: ${e.message}` };
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

  let html;
  try {
    html = await res.text();
  } catch (e) {
    return { ok: false, http_status: httpStatus, content_type: contentType, error: `body: ${e.message}` };
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
  let parsed;
  try {
    const stdout = await spawnClaude(claudeBin, promptText, 'sonnet', timeoutMs);
    parsed = parseSummaryJson(stdout);
  } catch (e) {
    return {
      ok: false, http_status: httpStatus, content_type: contentType,
      title, meta_description: metaDescription, og_title: ogTitle,
      og_description: ogDescription, og_image: ogImage, og_type: ogType,
      error: `claude: ${e.message}`,
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

function pickMeta(root, selectors) {
  for (const sel of selectors) {
    const v = root.querySelector(sel)?.getAttribute('content');
    if (v) return v.replace(/\s+/g, ' ').trim().slice(0, 500);
  }
  return '';
}

function parseSummaryJson(raw) {
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
    summary: String(obj.summary ?? '').trim().slice(0, 400),
    kind: String(obj.kind ?? '').trim().slice(0, 40),
  };
}

function spawnClaude(bin, prompt, model, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ['-p'];
    if (model) args.push('--model', model);
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timeout after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`exit ${code}: ${stderr.slice(0, 300)}`));
      else resolve(stdout);
    });
    child.stdin.end(prompt, 'utf8');
  });
}
