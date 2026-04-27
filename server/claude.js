import { spawn } from 'node:child_process';
import { parse as parseHtml } from 'node-html-parser';

const MAX_TEXT = 30000; // chars passed to claude

/**
 * Extract a reasonably clean text representation of an HTML page.
 */
export function htmlToText(html) {
  const root = parseHtml(html, {
    blockTextElements: { script: false, style: false, noscript: false, pre: true },
  });
  // Remove obviously useless nodes.
  root.querySelectorAll('script, style, noscript, svg, iframe, link, meta').forEach(n => n.remove());
  const text = root.text.replace(/[\t  ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

/**
 * Ask Claude Code (CLI, non-interactive) to produce a summary + 3-5 categories.
 * Returns { summary: string, categories: string[] }.
 */
export async function summarizeWithClaude({ url, title, html, claudeBin = 'claude', timeoutMs = 180_000 }) {
  const text = htmlToText(html).slice(0, MAX_TEXT);

  const prompt = [
    'あなたはブックマークの要約担当です。',
    '次の Web ページの内容を読み、以下を JSON 1 オブジェクトのみで出力してください。前後の説明文・コードフェンスは禁止です。',
    '',
    'スキーマ:',
    '{',
    '  "summary": "日本語で 200〜400 文字の要約",',
    '  "categories": ["3〜5 個の短いカテゴリ名 (日本語、各 2〜10 文字)"]',
    '}',
    '',
    `TITLE: ${title}`,
    `URL: ${url}`,
    '',
    'CONTENT:',
    text,
  ].join('\n');

  const stdout = await runClaude(claudeBin, prompt, timeoutMs);
  return parseClaudeJson(stdout);
}

function runClaude(bin, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude CLI exited with ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseClaudeJson(raw) {
  let text = raw.trim();
  // Strip code fences if Claude wrapped it.
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  // Find first { ... last }.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) text = text.slice(first, last + 1);

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse Claude output as JSON: ${e.message}\nRaw (first 300): ${raw.slice(0, 300)}`);
  }
  const summary = String(obj.summary ?? '').trim();
  const cats = Array.isArray(obj.categories) ? obj.categories : [];
  const categories = cats.map(c => String(c).trim()).filter(Boolean).slice(0, 5);
  if (!summary) throw new Error('Claude output had empty summary');
  if (categories.length === 0) throw new Error('Claude output had no categories');
  return { summary, categories };
}
