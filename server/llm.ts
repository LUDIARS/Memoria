// LLM dispatch — every place that used to call `spawn('claude', ...)` should
// route through runLlm({ task, prompt, ... }) so the user can pick a provider
// per task: Claude CLI, Gemini CLI, Codex CLI, or the OpenAI Chat API.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { forwardToConcordia } from './concordia-forward.js';

export type LlmTaskName =
  | 'summarize' | 'dig' | 'dig_preview' | 'cloud_extract' | 'cloud_validate'
  | 'domain_classify' | 'page_summary'
  | 'diary_work' | 'diary_highlights' | 'diary_weekly'
  | 'meal_vision' | 'meal_calorie'
  | 'app_classify'
  | 'recommendation_agent' | 'recommendation_synthesize'
  | 'endpoint_identify'
  | 'discord_route'
  | 'rss_score' | 'rss_summarize' | 'rss_digest'
  | 'weather_rain_verify' | 'weather_likely_place'
  | 'article_topics' | 'article_write' | 'ai_advice';

export const TASKS: LlmTaskName[] = [
  'summarize', 'dig', 'dig_preview', 'cloud_extract', 'cloud_validate',
  'domain_classify', 'page_summary',
  'diary_work', 'diary_highlights', 'diary_weekly',
  'meal_vision', 'meal_calorie',
  'app_classify',
  'recommendation_agent', 'recommendation_synthesize',
  'endpoint_identify',
  'discord_route',
  'rss_score', 'rss_summarize', 'rss_digest',
  'weather_rain_verify', 'weather_likely_place',
  'article_topics', 'article_write', 'ai_advice',
];

const TASK_DEFAULT_MODELS: Partial<Record<LlmTaskName, string>> = {
  domain_classify: 'sonnet',
  page_summary: 'sonnet',
  diary_work: 'sonnet',
  diary_highlights: 'claude-opus-4-7[1m]',
  diary_weekly: 'claude-opus-4-7[1m]',
  meal_vision: 'sonnet',
  meal_calorie: 'sonnet',
  app_classify: 'sonnet',
  recommendation_agent: 'sonnet',
  recommendation_synthesize: 'claude-opus-4-7[1m]',
  endpoint_identify: 'sonnet',
  rss_score: 'haiku',      // 多数記事を高速・安価に採点する。
  rss_summarize: 'haiku',  // 記事ごとの短い要約。 数が出るので安価に。
  rss_digest: 'sonnet',    // 上位記事を束ねる日次ブリーフィング (品質寄り)。
  weather_rain_verify: 'sonnet',    // 複数ソースの一致から雨を検証 + ルール提案。
  weather_likely_place: 'sonnet',   // 曜日 × 訪問履歴から行きがちな場所を推定。
  article_topics: 'sonnet',          // 前日データから記事候補トピックを JSON 抽出・ランク付け。
  article_write: 'claude-opus-4-7[1m]', // 1 トピックを本記事 (Markdown) に。 品質寄り + 長文。
  ai_advice: 'sonnet',               // 週次データから助言 (Markdown)。
};

// gamma = ローカル LLM レーン。 OpenAI 互換エンドポイント (既定 Ollama
// http://localhost:11434/v1) に HTTP で繋ぐ。 専用 CLI は持たず openai と同じ api kind。
// 課金ゼロ・ローカル完結。 想定モデル Gemma 4 12B 等の reasoning モデル。
export type LlmProviderKey = 'algorithm' | 'claude' | 'codex' | 'gemini' | 'openai' | 'gamma';

export interface LlmProviderInfo {
  label: string;
  kind: 'cli' | 'api' | 'none';
  defaultBin?: string;
  supportsTools: boolean;
  supportsModel: boolean;
  jsonOutput?: boolean;
}

export const PROVIDERS: Record<LlmProviderKey, LlmProviderInfo> = {
  algorithm: { label: 'アルゴリズム (AI なし)', kind: 'none', supportsTools: false, supportsModel: false },
  claude:    { label: 'Claude CLI', kind: 'cli', defaultBin: 'claude', supportsTools: true, supportsModel: true },
  codex:     { label: 'Codex CLI', kind: 'cli', defaultBin: 'codex', supportsTools: false, supportsModel: true, jsonOutput: true },
  gemini:    { label: 'Gemini CLI', kind: 'cli', defaultBin: 'gemini', supportsTools: false, supportsModel: true },
  openai:    { label: 'OpenAI API', kind: 'api', supportsTools: false, supportsModel: true },
  gamma:     { label: 'Gamma (ローカル LLM / Ollama)', kind: 'api', supportsTools: false, supportsModel: true },
};

export interface LlmModelOption {
  id: string;
  label: string;
}

export const PROVIDER_MODELS: Record<LlmProviderKey, LlmModelOption[]> = {
  algorithm: [],
  claude: [
    { id: 'sonnet',                 label: 'Sonnet 4.6 (default)' },
    { id: 'haiku',                  label: 'Haiku 4.5 (fast)' },
    { id: 'opus',                   label: 'Opus 4.7' },
    { id: 'claude-opus-4-7[1m]',    label: 'Opus 4.7 (1M context)' },
    { id: 'claude-sonnet-4-6',      label: 'Sonnet 4.6 (full id)' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (full id)' },
  ],
  codex: [
    { id: '5.3-codex',  label: '5.3-codex (default)' },
    { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
  ],
  gemini: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (default)' },
    { id: 'gemini-2.5-pro',   label: 'Gemini 2.5 Pro' },
  ],
  openai: [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini (default)' },
    { id: 'gpt-4o',      label: 'GPT-4o' },
    { id: 'gpt-5-mini',  label: 'GPT-5 mini' },
  ],
  gamma: [
    { id: 'gemma4:12b',         label: 'Gemma 4 12B (default)' },
    { id: 'qwen2.5-coder:14b',  label: 'Qwen2.5 Coder 14B' },
  ],
};

export const PROVIDER_DEFAULT_MODEL: Partial<Record<LlmProviderKey, string>> = {
  claude: 'sonnet',
  codex:  '5.3-codex',
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
  gamma:  'gemma4:12b',
};

/** gamma の既定 OpenAI 互換エンドポイント (Ollama)。 設定で上書き可。 */
const GAMMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

interface LlmTaskConfig {
  provider: LlmProviderKey;
  model?: string;
}

interface LlmRuntimeConfig {
  tasks: Partial<Record<LlmTaskName, LlmTaskConfig>>;
  bins: { claude: string; gemini: string; codex: string };
  openai_api_key: string;
  openai_model: string;
  // gamma = ローカル LLM (OpenAI 互換)。 base_url 既定 Ollama、 api_key は任意 (vLLM 等の Bearer)。
  gamma_base_url: string;
  gamma_api_key: string;
  gamma_model: string;
  git_bash_path: string;
}

let cfg: LlmRuntimeConfig = {
  tasks: Object.fromEntries(TASKS.map(t => [t, { provider: 'claude' as LlmProviderKey }])) as Partial<Record<LlmTaskName, LlmTaskConfig>>,
  bins: { claude: 'claude', gemini: 'gemini', codex: 'codex' },
  openai_api_key: '',
  openai_model: 'gpt-4o-mini',
  gamma_base_url: GAMMA_DEFAULT_BASE_URL,
  gamma_api_key: '',
  gamma_model: 'gemma4:12b',
  git_bash_path: '',
};

export function getLlmConfig(): LlmRuntimeConfig {
  return JSON.parse(JSON.stringify(cfg));
}

export function loadLlmConfigFromSettings(settings: Record<string, string | null | undefined>): void {
  const tasks: Partial<Record<LlmTaskName, LlmTaskConfig>> = {};
  for (const t of TASKS) {
    tasks[t] = {
      provider: (settings[`llm.${t}.provider`] || 'claude') as LlmProviderKey,
      model: settings[`llm.${t}.model`] || '',
    };
  }
  cfg = {
    tasks,
    bins: {
      claude: settings['llm.bin.claude'] || 'claude',
      gemini: settings['llm.bin.gemini'] || 'gemini',
      codex:  settings['llm.bin.codex']  || 'codex',
    },
    openai_api_key: settings['llm.openai.api_key'] || '',
    openai_model:   settings['llm.openai.model']   || 'gpt-4o-mini',
    gamma_base_url: settings['llm.gamma.base_url'] || GAMMA_DEFAULT_BASE_URL,
    gamma_api_key:  settings['llm.gamma.api_key']  || '',
    gamma_model:    settings['llm.gamma.model']    || 'gemma4:12b',
    git_bash_path:  settings['runtime.git_bash_path'] || process.env.CLAUDE_CODE_GIT_BASH_PATH || '',
  };
}

export interface LlmConfigPatch {
  tasks?: Partial<Record<LlmTaskName, Partial<LlmTaskConfig>>>;
  bins?: Partial<{ claude: string; gemini: string; codex: string }>;
  openai_api_key?: string;
  openai_model?: string;
  gamma_base_url?: string;
  gamma_api_key?: string;
  gamma_model?: string;
  git_bash_path?: string;
}

export function settingsPatchFromConfig(patch: LlmConfigPatch): Record<string, string> {
  const out: Record<string, string> = {};
  if (patch.tasks) {
    for (const [t, v] of Object.entries(patch.tasks)) {
      if (v?.provider !== undefined) out[`llm.${t}.provider`] = v.provider;
      if (v?.model !== undefined)    out[`llm.${t}.model`] = v.model;
    }
  }
  if (patch.bins) {
    for (const [k, v] of Object.entries(patch.bins)) {
      if (v !== undefined) out[`llm.bin.${k}`] = v;
    }
  }
  if (patch.openai_api_key !== undefined) out['llm.openai.api_key'] = patch.openai_api_key;
  if (patch.openai_model !== undefined)   out['llm.openai.model']   = patch.openai_model;
  if (patch.gamma_base_url !== undefined) out['llm.gamma.base_url'] = patch.gamma_base_url;
  if (patch.gamma_api_key !== undefined)  out['llm.gamma.api_key']  = patch.gamma_api_key;
  if (patch.gamma_model !== undefined)    out['llm.gamma.model']    = patch.gamma_model;
  if (patch.git_bash_path !== undefined)  out['runtime.git_bash_path'] = patch.git_bash_path;
  return out;
}

export interface RunLlmArgs {
  task: LlmTaskName;
  prompt: string;
  tools?: string[];
  timeoutMs?: number;
}

/**
 * Run an LLM call for a named task. Falls back to Claude CLI if the configured
 * provider isn't usable (e.g. OpenAI selected but no API key set).
 *
 * Concordia forwarding: 開始 / 終了 / エラー で `forwardToConcordia` を呼ぶ.
 * fire-and-forget なので Memoria の本処理時間には影響しない.
 */
export async function runLlm({ task, prompt, tools, timeoutMs = 180_000 }: RunLlmArgs): Promise<string> {
  const start = Date.now();
  const taskCfg = cfg.tasks[task] || { provider: 'claude' as LlmProviderKey };
  let provider: LlmProviderKey = taskCfg.provider || 'claude';
  if (provider === 'openai' && !cfg.openai_api_key) provider = 'claude';
  // gamma は base_url が無いと繋げないので claude フォールバック (既定は Ollama なので通常起きない)。
  if (provider === 'gamma' && !cfg.gamma_base_url) provider = 'claude';
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider: ${provider}`);
  if (p.kind === 'none') return '';

  const modelToUse: string =
    taskCfg.model ||
    (provider === 'gamma'
      ? (cfg.gamma_model || PROVIDER_DEFAULT_MODEL.gamma || 'gemma4:12b')
      : p.kind === 'api'
        ? (cfg.openai_model || PROVIDER_DEFAULT_MODEL.openai || 'gpt-4o-mini')
        : (TASK_DEFAULT_MODELS[task] || PROVIDER_DEFAULT_MODEL[provider] || ''));

  forwardToConcordia({ kind: 'llm-request', task, provider, model: modelToUse, text: prompt });

  try {
    let result: string;
    if (p.kind === 'api') {
      const isGamma = provider === 'gamma';
      result = await runOpenAiCompatible({
        baseUrl: isGamma ? cfg.gamma_base_url : 'https://api.openai.com/v1',
        apiKey:  isGamma ? cfg.gamma_api_key  : cfg.openai_api_key,
        requireApiKey: !isGamma,
        // reasoning モデル (Gemma 4 等) は思考でトークンを使うので余裕を持たせる
        // (max_tokens が小さいと content が空になる)。 openai は従来通り未指定。
        maxTokens: isGamma ? 4096 : undefined,
        label: isGamma ? 'Gamma' : 'OpenAI',
        model: modelToUse,
        prompt, timeoutMs,
      });
    } else {
      // CLI providers
      const bin = (cfg.bins as Record<string, string>)[provider] || p.defaultBin || provider;
      const args = buildCliArgs({
        provider,
        model: modelToUse,
        tools,
        supportsModel: p.supportsModel,
        supportsTools: p.supportsTools,
      });
      const env = { ...process.env };
      if (provider === 'claude' && cfg.git_bash_path) {
        env.CLAUDE_CODE_GIT_BASH_PATH = cfg.git_bash_path;
      }
      result = await runCli({ bin, args, prompt, timeoutMs, env, label: provider, jsonOutput: !!p.jsonOutput });
    }
    forwardToConcordia({
      kind: 'llm-response',
      task,
      provider,
      model: modelToUse,
      text: result,
      durationMs: Date.now() - start,
    });
    return result;
  } catch (err) {
    forwardToConcordia({
      kind: 'llm-error',
      task,
      provider,
      model: modelToUse,
      text: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    });
    throw err;
  }
}

function buildCliArgs({
  provider, model, tools, supportsModel, supportsTools,
}: {
  provider: LlmProviderKey;
  model: string;
  tools: string[] | undefined;
  supportsModel: boolean;
  supportsTools: boolean;
}): string[] {
  if (provider === 'codex') {
    const args: string[] = [
      'exec',
      '--json',
      '--color', 'never',
      '--ask-for-approval', 'never',
      '--sandbox', 'workspace-write',
    ];
    if (model && supportsModel) args.push('--model', model);
    args.push('-');
    return args;
  }
  const args: string[] = ['-p'];
  if (model && supportsModel) args.push('--model', model);
  if (tools && tools.length && supportsTools) args.push('--allowedTools', tools.join(','));
  return args;
}

function runCli({
  bin, args, prompt, timeoutMs, env, label, jsonOutput = false,
}: {
  bin: string;
  args: string[];
  prompt: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  label: string;
  jsonOutput?: boolean;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env });
    } catch (e: unknown) {
      reject(new Error(`spawn ${bin}: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${label} CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', err => { clearTimeout(timer); reject(new Error(`${label} CLI: ${err.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${label} CLI exited ${code}: ${stderr.slice(0, 400)}`));
      else resolve(jsonOutput ? extractCodexLastMessage(stdout) : stdout);
    });
    child.stdin.end(prompt, 'utf8');
  });
}

function extractCodexLastMessage(raw: string): string {
  let lastText = '';
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  for (const line of lines) {
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { continue; }
    const text = extractTextFromCodexEvent(obj);
    if (text) lastText = text;
  }
  return lastText || raw;
}

interface CodexEvent {
  message?: unknown;
  text?: unknown;
  delta?: unknown;
  payload?: { message?: unknown; text?: unknown; delta?: unknown } & Record<string, unknown>;
}

function extractTextFromCodexEvent(obj: unknown): string {
  if (!obj || typeof obj !== 'object') return '';
  const o = obj as CodexEvent;
  const candidates: unknown[] = [
    o.message,
    o.text,
    o.delta,
    o.payload?.message,
    o.payload?.text,
    o.payload?.delta,
    o.payload,
  ];
  for (const candidate of candidates) {
    const text = extractContentText(candidate);
    if (text) return text;
  }
  return '';
}

interface ContentLike {
  role?: unknown;
  content?: unknown;
  text?: unknown;
}

function extractContentText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractContentText).filter(Boolean).join('\n');
  if (typeof value !== 'object') return '';
  const v = value as ContentLike;
  if (v.role && v.role !== 'assistant') return '';
  if (typeof v.content === 'string') return v.content;
  if (Array.isArray(v.content)) return extractContentText(v.content);
  if (typeof v.text === 'string') return v.text;
  return '';
}

/**
 * OpenAI 互換 `/v1/chat/completions` を叩く共通ランナー。 openai (api.openai.com) と
 * gamma (Ollama 等のローカル OpenAI 互換) の両方が使う。
 *
 * - baseUrl は末尾 `/v1` まで (例 `https://api.openai.com/v1` / `http://localhost:11434/v1`)。
 * - apiKey は openai では必須、 gamma (Ollama) では任意 (設定時のみ Bearer を送る)。
 * - maxTokens を渡すと `max_tokens` を付ける (Gemma 4 等 reasoning モデルの空応答対策)。
 */
async function runOpenAiCompatible({
  baseUrl, apiKey, requireApiKey, model, prompt, timeoutMs, maxTokens, label,
}: {
  baseUrl: string;
  apiKey: string;
  requireApiKey: boolean;
  model: string;
  prompt: string;
  timeoutMs: number;
  maxTokens?: number;
  label: string;
}): Promise<string> {
  if (requireApiKey && !apiKey) throw new Error(`${label} API key is not configured`);
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
    };
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const errBody = (await res.text()).slice(0, 400);
      throw new Error(`${label} ${res.status}: ${errBody}`);
    }
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}
