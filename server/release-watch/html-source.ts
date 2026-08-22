import { parse as parseHtml } from 'node-html-parser';
import { runLlm } from '../llm.js';
import { fetchPublicText } from '../shared/public-fetch.js';
import { extractJsonArray } from './llm-json.js';
import type { RawRelease, ReleaseSource } from './types.js';

const MAX_PAGE_TEXT_CHARS = 40_000;
const MIN_PAGE_TEXT_CHARS = 200;

export function htmlToPlainText(html: string): string {
  const root = parseHtml(html, { blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  root.querySelectorAll('script, style, noscript, svg, iframe, link, meta, nav, footer').forEach((n) => n.remove());
  return root.text.replace(/[\t  ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function buildExtractPrompt(source: ReleaseSource, pageText: string, limit: number): string {
  return [
    `次のテキストは「${source.name}」の公式更新履歴ページ (${source.url}) の本文です。`,
    `新しい順に最大 ${limit} 件のバージョンを抜き出し、 JSON 配列だけを出力してください。`,
    '各要素: {"version": "バージョン名", "url": "そのバージョンの URL (不明なら null)", "publishedAt": "YYYY-MM-DD または null", "body": "そのバージョンの変更点を原文のまま 1500 文字以内"}',
    'バージョンが見つからなければ [] を返してください。 説明文やコードフェンスは不要です。',
    '',
    '---',
    pageText.slice(0, MAX_PAGE_TEXT_CHARS),
  ].join('\n');
}

interface ExtractedItem {
  version?: unknown;
  url?: unknown;
  publishedAt?: unknown;
  body?: unknown;
}

export function coerceExtractedReleases(source: ReleaseSource, raw: unknown[]): RawRelease[] {
  const include = source.includePattern ? new RegExp(source.includePattern) : null;
  const out: RawRelease[] = [];
  for (const item of raw as ExtractedItem[]) {
    if (!item || typeof item !== 'object') continue;
    const version = typeof item.version === 'string' ? item.version.trim() : '';
    if (!version || (include && !include.test(version))) continue;
    let url = source.url;
    if (typeof item.url === 'string') {
      try {
        const resolved = new URL(item.url, source.url);
        if (resolved.protocol === 'http:' || resolved.protocol === 'https:') url = resolved.toString();
      } catch { /* keep source url */ }
    }
    out.push({
      version,
      url,
      publishedAt: typeof item.publishedAt === 'string' && item.publishedAt.trim() ? item.publishedAt.trim() : null,
      body: typeof item.body === 'string' ? item.body : '',
    });
  }
  return out;
}

export interface HtmlSourceDeps {
  fetchText?: (url: string) => Promise<{ text: string }>;
  extract?: (prompt: string) => Promise<string>;
}

/**
 * RSS も API も無い公式ページ向け。 本文テキストを LLM に渡してバージョン一覧を抽出する
 * (JS 描画で本文が空のページは「本文が取れない」として失敗させ、 UI に出す)。
 */
export async function fetchHtmlReleases(source: ReleaseSource, limit: number, deps: HtmlSourceDeps = {}): Promise<RawRelease[]> {
  const fetchText = deps.fetchText ?? ((url: string) => fetchPublicText(url));
  const extract = deps.extract ?? ((prompt: string) => runLlm({ task: 'release_extract', prompt }));
  const { text: html } = await fetchText(source.url);
  const pageText = htmlToPlainText(html);
  if (pageText.length < MIN_PAGE_TEXT_CHARS) {
    throw new Error('ページ本文が取得できません (JavaScript 描画ページの可能性)。 RSS か GitHub の URL に変えてください');
  }
  const raw = await extract(buildExtractPrompt(source, pageText, limit));
  return coerceExtractedReleases(source, extractJsonArray(raw)).slice(0, limit);
}
