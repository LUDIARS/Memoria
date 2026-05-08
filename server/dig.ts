// Dig (deep research) — drive the claude CLI with WebSearch + WebFetch tools
// allowed, ask it to return a JSON list of sources for a topic.

import { runLlm } from './llm.js';

interface SearchEngineConfig {
  name: string;
  label: string;
  serpUrl: ((q: string) => string) | null;
}

const SEARCH_ENGINES: Record<string, SearchEngineConfig> = {
  default:    { name: 'default', label: 'デフォルト (claude が自動選択)', serpUrl: null },
  google:     { name: 'Google', label: 'Google', serpUrl: q => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  bing:       { name: 'Bing', label: 'Bing', serpUrl: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  duckduckgo: { name: 'DuckDuckGo', label: 'DuckDuckGo', serpUrl: q => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
  brave:      { name: 'Brave Search', label: 'Brave Search', serpUrl: q => `https://search.brave.com/search?q=${encodeURIComponent(q)}` },
};

export interface SearchEngineOption {
  key: string;
  name: string;
  label: string;
}

export function listSearchEngines(): SearchEngineOption[] {
  return Object.entries(SEARCH_ENGINES).map(([key, v]) => ({ key, name: v.name, label: v.label }));
}

function engineFor(key: string): SearchEngineConfig {
  return SEARCH_ENGINES[key] || SEARCH_ENGINES.default;
}

function engineInstruction(engine: SearchEngineConfig, query: string): string {
  if (!engine.serpUrl) return '検索エンジンは claude の判断に任せます。';
  const serp = engine.serpUrl(query);
  return [
    `検索エンジンは ${engine.name} を使ってください。`,
    `WebFetch は最初に ${serp} を取り、SERP から候補を抽出してから個別ページを取得してください。`,
    `他の検索エンジンや AI overview ジェネレータは使わないこと。`,
  ].join('\n');
}

export interface DigThemeContext {
  queries?: string[];
  topics?: { word: string }[];
  sources?: { url: string }[];
}

function themeContextBlock(theme: string | null, themeContext: DigThemeContext | null): string {
  if (!theme || !themeContext) return '';
  const { queries = [], topics = [], sources = [] } = themeContext;
  if (!queries.length && !topics.length && !sources.length) {
    return [
      '',
      `THEME: "${theme}" (まだ過去のディグなし — 最初の調査)`,
      '',
    ].join('\n');
  }
  const lines: string[] = [''];
  lines.push(`THEME: "${theme}"`);
  lines.push('THIS IS PART OF AN ONGOING THEME — 既に取得済の文脈は以下:');
  if (queries.length) {
    lines.push('  過去のクエリ:');
    for (const q of queries.slice(0, 6)) {
      lines.push(`    - ${q}`);
    }
  }
  if (topics.length) {
    const top = topics.slice(0, 16).map(t => t.word).join(', ');
    lines.push(`  既知のキーワード: ${top}`);
  }
  if (sources.length) {
    lines.push('  既出のソース (重複は避ける):');
    for (const s of sources.slice(0, 8)) {
      lines.push(`    - ${s.url}`);
    }
  }
  lines.push(
    '注意: 既出のキーワード / ソースを単純に再掲しない。 上記文脈と差分を生む新しい視点 / 新しいソースを優先せよ。',
  );
  lines.push('');
  return lines.join('\n');
}

interface PromptArgs {
  query: string;
  engine: SearchEngineConfig;
  theme: string | null;
  themeContext: DigThemeContext | null;
}

const PROMPT_TEMPLATE = ({ query, engine, theme, themeContext }: PromptArgs): string => [
  'You are a research agent. Use Web search and fetching to gather authoritative sources for the topic the user provides.',
  engineInstruction(engine, query),
  themeContextBlock(theme, themeContext),
  'Return STRICTLY one JSON object and nothing else (no prose, no code fences):',
  '',
  '{',
  '  "query": "<the original query>",',
  '  "summary": "1〜3 段落で領域を概観 (日本語)",',
  '  "engine": "<used search engine>",',
  '  "sources": [',
  '    {',
  '      "url": "https://...",',
  '      "title": "...",',
  '      "snippet": "1〜2 文で、なぜこのソースが関連するか",',
  '      "topics": ["keyword1", "keyword2", "keyword3"]',
  '    }',
  '  ]',
  '}',
  '',
  '- 8〜12 件のソースを返す。',
  '- ドメインや視点が偏らないよう多様性を意識する。',
  '- 各ソースの topics は 2〜4 個。後でグラフ化に使う。',
  '- 重複 URL や無関係な広告ページは除外。',
  theme ? '- THEME 文脈の既出ソースは含めない (上の THEME ブロック参照)。' : '',
  '',
  `QUERY: ${query}`,
].filter(Boolean).join('\n');

const PREVIEW_PROMPT_TEMPLATE = ({ query, engine }: { query: string; engine: SearchEngineConfig }): string => [
  'You are returning a SERP-style preview as fast as possible.',
  engineInstruction(engine, query),
  'Use ONLY web search — do NOT fetch or read result pages.',
  'If the search engine displays an AI overview / generative summary, capture it verbatim.',
  '',
  'Return STRICTLY one JSON object and nothing else (no prose, no code fences):',
  '',
  '{',
  '  "ai_overview": "search engine の AI overview があればその文章 (なければ空文字)",',
  '  "engine": "<used search engine>",',
  '  "results": [',
  '    {',
  '      "title": "...",',
  '      "url": "https://...",',
  '      "snippet": "検索エンジンが返したスニペット 1〜2 文",',
  '      "domain": "..."',
  '    }',
  '  ]',
  '}',
  '',
  '- 上位 8〜10 件のみ。',
  '- ai_overview は要約済みの段落 1〜3。なければ "" を返す。',
  '- 各ページの本文を取りにいかないこと (速さが最優先)。',
  '',
  `QUERY: ${query}`,
].join('\n');

export interface DigPreviewResult {
  ai_overview: string;
  results: { title: string; url: string; snippet: string; domain: string }[];
}

export async function runDigPreview({
  query, searchEngine = 'default', timeoutMs = 90_000,
}: {
  query: string;
  searchEngine?: string;
  timeoutMs?: number;
}): Promise<DigPreviewResult> {
  const engine = engineFor(searchEngine);
  const prompt = PREVIEW_PROMPT_TEMPLATE({ query, engine });
  const stdout = await runLlm({
    task: 'dig_preview', prompt, tools: ['WebSearch', 'WebFetch'], timeoutMs,
  });
  return parsePreview(stdout);
}

export interface DigSource {
  url: string;
  title: string;
  snippet: string;
  topics: string[];
}

export interface DigResult {
  query: string;
  summary: string;
  sources: DigSource[];
}

export async function runDig({
  query, searchEngine = 'default', timeoutMs = 600_000,
  theme = null, themeContext = null,
}: {
  query: string;
  searchEngine?: string;
  timeoutMs?: number;
  theme?: string | null;
  themeContext?: DigThemeContext | null;
}): Promise<DigResult> {
  const engine = engineFor(searchEngine);
  const prompt = PROMPT_TEMPLATE({ query, engine, theme, themeContext });
  const stdout = await runLlm({
    task: 'dig', prompt, tools: ['WebSearch', 'WebFetch'], timeoutMs,
  });
  return parseJsonStrict(stdout);
}

/**
 * ユーザーの query から軽量にテーマ文字列を抽出する。
 * クライアント / API 双方が同じロジックで揃えられるよう pure 関数。
 */
export function deriveDigTheme(query: unknown): string | null {
  if (typeof query !== 'string') return null;
  let text = query.trim();
  if (!text) return null;
  text = text.replace(/https?:\/\/\S+/g, ' ');
  const first = text.split(/[\n。.\?？]/)[0].trim();
  let theme = first.replace(/\s+/g, ' ').trim();
  if (!theme) return null;
  theme = theme
    .replace(/(について|に関して)?(教えて|調べて|まとめて|お願い|して?ほしい)?$/u, '')
    .replace(/(について|に関して|を調べて|を教えて|の話|の件|とは)$/u, '')
    .trim();
  if (theme.length > 30) theme = theme.slice(0, 30);
  return theme || null;
}

interface RawPreviewResultItem {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  domain?: unknown;
}

function parsePreview(raw: string): DigPreviewResult {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  let obj: { ai_overview?: unknown; results?: unknown };
  try {
    obj = JSON.parse(text);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`preview parse: ${msg}\nRaw: ${raw.slice(0, 400)}`);
  }
  const rawResults = Array.isArray(obj.results) ? (obj.results as RawPreviewResultItem[]) : [];
  return {
    ai_overview: String(obj.ai_overview ?? '').trim(),
    results: rawResults.map(r => ({
      title: String(r.title ?? '').trim(),
      url: String(r.url ?? '').trim(),
      snippet: String(r.snippet ?? '').trim(),
      domain: String(r.domain ?? '').trim() || extractDomain(String(r.url ?? '')),
    })).filter(r => /^https?:\/\//.test(r.url)),
  };
}

function extractDomain(url: string): string {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

interface RawSourceObject {
  url?: unknown;
  title?: unknown;
  snippet?: unknown;
  topics?: unknown;
}

function parseJsonStrict(raw: string): DigResult {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  let obj: { query?: unknown; summary?: unknown; sources?: unknown };
  try {
    obj = JSON.parse(text);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to parse claude output as JSON: ${msg}\nRaw: ${raw.slice(0, 400)}`);
  }
  if (!Array.isArray(obj.sources)) throw new Error('claude output missing sources[]');
  const rawSources = obj.sources as RawSourceObject[];
  return {
    query: String(obj.query ?? ''),
    summary: String(obj.summary ?? '').trim(),
    sources: rawSources.map((s, i) => ({
      url: String(s.url ?? '').trim(),
      title: String(s.title ?? '').trim() || `source-${i + 1}`,
      snippet: String(s.snippet ?? '').trim(),
      topics: Array.isArray(s.topics) ? (s.topics as unknown[]).map(t => String(t).trim()).filter(Boolean).slice(0, 6) : [],
    })).filter(s => /^https?:\/\//.test(s.url)),
  };
}
