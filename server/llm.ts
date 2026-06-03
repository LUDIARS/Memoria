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
  | 'rss_score' | 'rss_summarize' | 'rss_digest';

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
};

export type LlmProviderKey = 'algorithm' | 'claude' | 'codex' | 'gemini' | 'openai';

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
};

export const PROVIDER_DEFAULT_MODEL: Partial<Record<LlmProviderKey, string>> = {
  claude: 'sonnet',
  codex:  '5.3-codex',
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
};

interface LlmTaskConfig {
  provider: LlmProviderKey;
  model?: string;
}

interface LlmRuntimeConfig {
  tasks: Partial<Record<LlmTaskName, LlmTaskConfig>>;
  bins: { claude: string; gemini: string; codex: string };
  openai_api_key: string;
  openai_model: string;
  git_bash_path: string;
}

let cfg: LlmRuntimeConfig = {
  tasks: Object.fromEntries(TASKS.map(t => [t, { provider: 'claude' as LlmProviderKey }])) as Partial<Record<LlmTaskName, LlmTaskConfig>>,
  bins: { claude: 'claude', gemini: 'gemini', codex: 'codex' },
  openai_api_key: '',
  openai_model: 'gpt-4o-mini',
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
    git_bash_path:  settings['runtime.git_bash_path'] || process.env.CLAUDE_CODE_GIT_BASH_PATH || '',
  };
}

export interface LlmConfigPatch {
  tasks?: Partial<Record<LlmTaskName, Partial<LlmTaskConfig>>>;
  bins?: Partial<{ claude: string; gemini: string; codex: string }>;
  openai_api_key?: string;
  openai_model?: string;
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
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider: ${provider}`);
  if (p.kind === 'none') return '';

  const modelToUse: string =
    taskCfg.model ||
    (p.kind === 'api'
      ? (cfg.openai_model || PROVIDER_DEFAULT_MODEL.openai || 'gpt-4o-mini')
      : (TASK_DEFAULT_MODELS[task] || PROVIDER_DEFAULT_MODEL[provider] || ''));

  forwardToConcordia({ kind: 'llm-request', task, provider, model: modelToUse, text: prompt });

  try {
    let result: string;
    if (p.kind === 'api') {
      result = await runOpenAi({
        apiKey: cfg.openai_api_key,
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

async function runOpenAi({
  apiKey, model, prompt, timeoutMs,
}: {
  apiKey: string;
  model: string;
  prompt: string;
  timeoutMs: number;
}): Promise<string> {
  if (!apiKey) throw new Error('OpenAI API key is not configured');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 400);
      throw new Error(`OpenAI ${res.status}: ${body}`);
    }
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}
