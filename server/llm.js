// LLM dispatch — every place that used to call `spawn('claude', ...)` should
// route through runLlm({ task, prompt, ... }) so the user can pick a provider
// per task: Claude CLI, Gemini CLI, Codex CLI, or the OpenAI Chat API.
//
// Per-task config is loaded once at startup (and re-loaded on PATCH) from
// app_settings. Tasks recognised at the moment:
//   summarize, dig, dig_preview, cloud_extract, cloud_validate,
//   domain_classify, page_summary,
//   diary_work, diary_highlights, diary_weekly,
//   meal_vision (画像入力あり — Claude CLI 推奨),
//   meal_calorie (食品名テキスト → 標準カロリー推定)

import { spawn } from 'node:child_process';

export const TASKS = [
  'summarize', 'dig', 'dig_preview', 'cloud_extract', 'cloud_validate',
  'domain_classify', 'page_summary',
  'diary_work', 'diary_highlights', 'diary_weekly',
  'meal_vision', 'meal_calorie',
];

// When the user hasn't explicitly chosen a model for a task, fall back to these.
// Sonnet for cheap repeated work; Opus 1M for the integrative narratives.
const TASK_DEFAULT_MODELS = {
  domain_classify: 'sonnet',
  page_summary: 'sonnet',
  diary_work: 'sonnet',
  diary_highlights: 'claude-opus-4-7[1m]',
  diary_weekly: 'claude-opus-4-7[1m]',
  meal_vision: 'sonnet',
  meal_calorie: 'sonnet',
};

export const PROVIDERS = {
  algorithm: {
    label: 'アルゴリズム (AI なし)',
    kind: 'none',
    supportsTools: false,
    supportsModel: false,
  },
  claude: {
    label: 'Claude CLI',
    kind: 'cli',
    defaultBin: 'claude',
    supportsTools: true,
    supportsModel: true,
  },
  codex: {
    label: 'Codex CLI',
    kind: 'cli',
    defaultBin: 'codex',
    supportsTools: false,
    supportsModel: true,
    jsonOutput: true,
  },
  gemini: {
    label: 'Gemini CLI',
    kind: 'cli',
    defaultBin: 'gemini',
    supportsTools: false,
    supportsModel: true,
  },
  openai: {
    label: 'OpenAI API',
    kind: 'api',
    supportsTools: false,
    supportsModel: true,
  },
};

// 各 provider で選べる主要モデル一覧。空文字 id = provider のデフォルトを使う。
// 現行モデル (2026-05 時点) を網羅。新しいモデルが出たらここに追加すれば
// UI のドロップダウンが自動で更新される。
export const PROVIDER_MODELS = {
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

// 各 provider の既定モデル ID (model 未指定時に runCli で渡す値)。
export const PROVIDER_DEFAULT_MODEL = {
  claude: 'sonnet',
  codex:  '5.3-codex',
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
};

let cfg = {
  tasks: Object.fromEntries(TASKS.map(t => [t, { provider: 'claude' }])),
  bins: { claude: 'claude', gemini: 'gemini', codex: 'codex' },
  openai_api_key: '',
  openai_model: 'gpt-4o-mini',
  // Windows users running the Claude CLI from a packaged Node child need
  // CLAUDE_CODE_GIT_BASH_PATH set or the CLI dies looking for bash. The
  // desktop app stashes its discovery here.
  git_bash_path: '',
};

export function getLlmConfig() {
  return JSON.parse(JSON.stringify(cfg));
}

export function loadLlmConfigFromSettings(settings) {
  // settings is the { key: value } map from app_settings.
  const tasks = {};
  for (const t of TASKS) {
    tasks[t] = {
      provider: settings[`llm.${t}.provider`] || 'claude',
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

export function settingsPatchFromConfig(patch) {
  // Convert a partial { tasks, bins, openai_api_key, openai_model } back into
  // app_settings flat keys.
  const out = {};
  if (patch.tasks) {
    for (const [t, v] of Object.entries(patch.tasks)) {
      if (v?.provider !== undefined) out[`llm.${t}.provider`] = v.provider;
      if (v?.model !== undefined)    out[`llm.${t}.model`] = v.model;
    }
  }
  if (patch.bins) {
    for (const [k, v] of Object.entries(patch.bins)) out[`llm.bin.${k}`] = v;
  }
  if (patch.openai_api_key !== undefined) out['llm.openai.api_key'] = patch.openai_api_key;
  if (patch.openai_model !== undefined)   out['llm.openai.model']   = patch.openai_model;
  if (patch.git_bash_path !== undefined)  out['runtime.git_bash_path'] = patch.git_bash_path;
  return out;
}

/**
 * Run an LLM call for a named task. Falls back to Claude CLI if the configured
 * provider isn't usable (e.g. OpenAI selected but no API key set).
 *
 * Args:
 *   task        — one of TASKS
 *   prompt      — the full prompt text (sent over stdin for CLIs)
 *   tools       — optional array (e.g. ['WebSearch', 'WebFetch']) only honoured
 *                 by providers that support it (claude)
 *   timeoutMs
 */
export async function runLlm({ task, prompt, tools, timeoutMs = 180_000 }) {
  const taskCfg = cfg.tasks[task] || { provider: 'claude' };
  let provider = taskCfg.provider || 'claude';
  // Fallback: OpenAI without a key drops back to claude.
  if (provider === 'openai' && !cfg.openai_api_key) provider = 'claude';
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider: ${provider}`);
  // 'algorithm' provider = "AI なし" 指定。タスクごとに deterministic な
  // 代替を持たせる責務は呼び出し側にあるので、ここでは空文字を返す。
  if (p.kind === 'none') return '';
  if (p.kind === 'api') {
    return runOpenAi({
      apiKey: cfg.openai_api_key,
      model: taskCfg.model || cfg.openai_model || PROVIDER_DEFAULT_MODEL.openai,
      prompt, timeoutMs,
    });
  }
  // CLI providers
  const bin = cfg.bins[provider] || p.defaultBin;
  const modelToUse = taskCfg.model || TASK_DEFAULT_MODELS[task] || PROVIDER_DEFAULT_MODEL[provider] || '';
  const args = buildCliArgs({
    provider,
    model: modelToUse,
    tools,
    supportsModel: p.supportsModel,
    supportsTools: p.supportsTools,
  });
  // Pass CLAUDE_CODE_GIT_BASH_PATH to the Claude CLI on Windows. Configured
  // via settings → runtime.git_bash_path; falls back to the parent env.
  const env = { ...process.env };
  if (provider === 'claude' && cfg.git_bash_path) {
    env.CLAUDE_CODE_GIT_BASH_PATH = cfg.git_bash_path;
  }
  return runCli({ bin, args, prompt, timeoutMs, env, label: provider, jsonOutput: !!p.jsonOutput });
}

function buildCliArgs({ provider, model, tools, supportsModel, supportsTools }) {
  if (provider === 'codex') {
    const args = [
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

  const args = ['-p'];
  if (model && supportsModel) args.push('--model', model);
  if (tools && supportsTools) args.push('--allowedTools', tools.join(','));
  return args;
}

function runCli({ bin, args, prompt, timeoutMs, env, label, jsonOutput = false }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env });
    } catch (e) {
      reject(new Error(`spawn ${bin}: ${e.message}`));
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

function extractCodexLastMessage(raw) {
  let lastText = '';
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const text = extractTextFromCodexEvent(obj);
    if (text) lastText = text;
  }
  return lastText || raw;
}

function extractTextFromCodexEvent(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const candidates = [
    obj.message,
    obj.text,
    obj.delta,
    obj.payload?.message,
    obj.payload?.text,
    obj.payload?.delta,
    obj.payload,
  ];
  for (const candidate of candidates) {
    const text = extractContentText(candidate);
    if (text) return text;
  }
  return '';
}

function extractContentText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractContentText).filter(Boolean).join('\n');
  if (typeof value !== 'object') return '';
  if (value.role && value.role !== 'assistant') return '';
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) return extractContentText(value.content);
  if (typeof value.text === 'string') return value.text;
  return '';
}

async function runOpenAi({ apiKey, model, prompt, timeoutMs }) {
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
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}
