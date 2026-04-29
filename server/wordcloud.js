// Word-cloud extraction — drive the claude CLI to produce a ranked list of
// keywords from a bundle of documents (bookmarks, dig sources, or a single
// article). Words that appear across multiple documents get higher weights;
// words unrelated to the bundle's summary are flagged kept=false.

import { spawn } from 'node:child_process';

const CLOUD_PROMPT = (label, docs) => [
  'You are extracting a word cloud from the provided documents.',
  '',
  'Return STRICTLY one JSON object and nothing else (no prose, no code fences):',
  '',
  '{',
  '  "summary": "1〜2 文で対象領域を要約 (日本語)",',
  '  "words": [',
  '    {',
  '      "word": "...",                    // 単語または短いフレーズ',
  '      "weight": 1〜100,                  // 出現/重要度スコア。複数の文書で繰り返し出る語は高く',
  '      "sources": 1以上,                  // この語が出現した文書数',
  '      "kept": true|false,               // summary と関係が薄ければ false',
  '      "reason": ""                      // kept=false の理由 (任意)',
  '    }',
  '  ]',
  '}',
  '',
  '- words は 25〜60 語まで返す。',
  '- 文書間で重複する語を優先し、重複度が高いほど weight を大きくする。',
  '- ストップワード、汎用語 (例: "the", "こと", "もの")、サイト名・著者名・年号単独は除外。',
  '- summary に直接関係しない語は kept=false にして reason を一言。',
  '- 言語は文書の主要言語に合わせる (日英混在なら原文の語をそのまま)。',
  '',
  `LABEL: ${label}`,
  '',
  'DOCUMENTS:',
  docs,
].join('\n');

const VALIDATE_PROMPT = (word, context) => [
  'Decide whether the WORD is meaningfully related to the CONTEXT.',
  'Return STRICTLY one JSON object and nothing else: {"related": true|false, "reason": "<短い理由>"}.',
  '',
  `WORD: ${word}`,
  `CONTEXT: ${context}`,
].join('\n');

export async function extractWordCloud({ label, docs, claudeBin = 'claude', timeoutMs = 300_000 }) {
  if (!docs || !docs.trim()) throw new Error('no documents to extract from');
  const stdout = await spawnClaude(claudeBin, CLOUD_PROMPT(label, docs), timeoutMs);
  return parseCloud(stdout);
}

export async function validateWordRelevance({ word, context, claudeBin = 'claude', timeoutMs = 60_000 }) {
  const stdout = await spawnClaude(claudeBin, VALIDATE_PROMPT(word, context), timeoutMs);
  return parseValidate(stdout);
}

function spawnClaude(bin, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p', prompt], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
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

function extractJsonObject(raw) {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  return JSON.parse(text);
}

function parseCloud(raw) {
  let obj;
  try { obj = extractJsonObject(raw); }
  catch (e) { throw new Error(`Failed to parse claude output as JSON: ${e.message}\nRaw: ${raw.slice(0, 400)}`); }
  if (!Array.isArray(obj.words)) throw new Error('claude output missing words[]');
  const words = obj.words
    .map(w => ({
      word: String(w.word ?? '').trim(),
      weight: clampWeight(Number(w.weight)),
      sources: Math.max(1, Math.floor(Number(w.sources) || 1)),
      kept: w.kept !== false,
      reason: String(w.reason ?? '').trim(),
    }))
    .filter(w => w.word.length > 0);
  return {
    summary: String(obj.summary ?? '').trim(),
    words,
  };
}

function parseValidate(raw) {
  let obj;
  try { obj = extractJsonObject(raw); }
  catch { return { related: false, reason: 'parse error' }; }
  return {
    related: !!obj.related,
    reason: String(obj.reason ?? '').trim(),
  };
}

function clampWeight(n) {
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(100, Math.round(n)));
}
