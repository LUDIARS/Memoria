// Dig (deep research) — drive the claude CLI with WebSearch + WebFetch tools
// allowed, ask it to return a JSON list of sources for a topic.
//
// We do NOT depend on a particular search engine API; the heavy lifting is
// claude's, and the prompt asks for JSON-only output that we then parse.

import { spawn } from 'node:child_process';

const PROMPT_TEMPLATE = (query) => [
  'You are a research agent. Use Web search and fetching to gather authoritative sources for the topic the user provides.',
  'Return STRICTLY one JSON object and nothing else (no prose, no code fences):',
  '',
  '{',
  '  "query": "<the original query>",',
  '  "summary": "1〜3 段落で領域を概観 (日本語)",',
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

export async function runDig({ query, claudeBin = 'claude', timeoutMs = 600_000 }) {
  const prompt = PROMPT_TEMPLATE(query);
  const stdout = await spawnClaude(claudeBin, prompt, timeoutMs);
  return parseJsonStrict(stdout);
}

function spawnClaude(bin, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ['-p', prompt, '--allowedTools', 'WebSearch,WebFetch'],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: false },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`));
      else resolve(stdout);
    });
  });
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
