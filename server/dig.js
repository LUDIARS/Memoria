// Dig (deep research) — drive the claude CLI with WebSearch + WebFetch tools
// allowed, ask it to return a JSON list of sources for a topic.
//
// The user can pin a specific search engine (Google / Bing / DuckDuckGo /
// Brave). The engine is delivered as an instruction in the prompt and as a
// preferred WebFetch URL pattern so claude actually queries the right SERP.

import { runLlm } from './llm.js';

const SEARCH_ENGINES = {
  default: { name: 'default', label: 'デフォルト (claude が自動選択)', serpUrl: null },
  google: { name: 'Google', label: 'Google', serpUrl: q => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  bing: { name: 'Bing', label: 'Bing', serpUrl: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  duckduckgo: { name: 'DuckDuckGo', label: 'DuckDuckGo', serpUrl: q => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
  brave: { name: 'Brave Search', label: 'Brave Search', serpUrl: q => `https://search.brave.com/search?q=${encodeURIComponent(q)}` },
};

export function listSearchEngines() {
  return Object.entries(SEARCH_ENGINES).map(([key, v]) => ({ key, name: v.name, label: v.label }));
}

function engineFor(key) {
  return SEARCH_ENGINES[key] || SEARCH_ENGINES.default;
}

function engineInstruction(engine, query) {
  if (!engine.serpUrl) return '検索エンジンは claude の判断に任せます。';
  const serp = engine.serpUrl(query);
  return [
    `検索エンジンは ${engine.name} を使ってください。`,
    `WebFetch は最初に ${serp} を取り、SERP から候補を抽出してから個別ページを取得してください。`,
    `他の検索エンジンや AI overview ジェネレータは使わないこと。`,
  ].join('\n');
}

const PROMPT_TEMPLATE = ({ query, engine }) => [
  'You are a research agent. Use Web search and fetching to gather authoritative sources for the topic the user provides.',
  engineInstruction(engine, query),
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
  '',
  `QUERY: ${query}`,
].join('\n');

const PREVIEW_PROMPT_TEMPLATE = ({ query, engine }) => [
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

export async function runDigPreview({ query, searchEngine = 'default', timeoutMs = 90_000 }) {
  const engine = engineFor(searchEngine);
  const prompt = PREVIEW_PROMPT_TEMPLATE({ query, engine });
  const stdout = await runLlm({
    task: 'dig_preview', prompt, tools: ['WebSearch', 'WebFetch'], timeoutMs,
  });
  return parsePreview(stdout);
}

export async function runDig({ query, searchEngine = 'default', timeoutMs = 600_000 }) {
  const engine = engineFor(searchEngine);
  const prompt = PROMPT_TEMPLATE({ query, engine });
  const stdout = await runLlm({
    task: 'dig', prompt, tools: ['WebSearch', 'WebFetch'], timeoutMs,
  });
  return parseJsonStrict(stdout);
}

function parsePreview(raw) {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { throw new Error(`preview parse: ${e.message}\nRaw: ${raw.slice(0, 400)}`); }
  return {
    ai_overview: String(obj.ai_overview ?? '').trim(),
    results: Array.isArray(obj.results) ? obj.results.map(r => ({
      title: String(r.title ?? '').trim(),
      url: String(r.url ?? '').trim(),
      snippet: String(r.snippet ?? '').trim(),
      domain: String(r.domain ?? '').trim() || extractDomain(r.url),
    })).filter(r => /^https?:\/\//.test(r.url)) : [],
  };
}

function extractDomain(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; }
}

function parseJsonStrict(raw) {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { throw new Error(`Failed to parse claude output as JSON: ${e.message}\nRaw: ${raw.slice(0, 400)}`); }
  if (!Array.isArray(obj.sources)) throw new Error('claude output missing sources[]');
  return {
    query: String(obj.query ?? ''),
    summary: String(obj.summary ?? '').trim(),
    sources: obj.sources.map((s, i) => ({
      url: String(s.url ?? '').trim(),
      title: String(s.title ?? '').trim() || `source-${i + 1}`,
      snippet: String(s.snippet ?? '').trim(),
      topics: Array.isArray(s.topics) ? s.topics.map(t => String(t).trim()).filter(Boolean).slice(0, 6) : [],
    })).filter(s => /^https?:\/\//.test(s.url)),
  };
}
