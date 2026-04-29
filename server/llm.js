// LLM dispatch — every place that used to call `spawn('claude', ...)` should
// route through runLlm({ task, prompt, ... }) so the user can pick a provider
// per task: Claude CLI, Gemini CLI, Codex CLI, or the OpenAI Chat API.
//
// Per-task config is loaded once at startup (and re-loaded on PATCH) from
// app_settings. Tasks recognised at the moment:
//   summarize / dig / dig_preview / cloud_extract / cloud_validate

import { spawn } from 'node:child_process';

export const TASKS = ['summarize', 'dig', 'dig_preview', 'cloud_extract', 'cloud_validate'];

export const PROVIDERS = {
  claude: {
    label: 'Claude CLI',
    kind: 'cli',
    defaultBin: 'claude',
    supportsTools: true,
    supportsModel: true,
  },
  gemini: {
    label: 'Gemini CLI',
    kind: 'cli',
    defaultBin: 'gemini',
    supportsTools: false,
    supportsModel: true,
  },
  codex: {
    label: 'Codex CLI',
    kind: 'cli',
    defaultBin: 'codex',
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

let cfg = {
  tasks: Object.fromEntries(TASKS.map(t => [t, { provider: 'claude' }])),
  bins: { claude: 'claude', gemini: 'gemini', codex: 'codex' },
  openai_api_key: '',
  openai_model: 'gpt-4o-mini',
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
  if (p.kind === 'api') {
    return runOpenAi({
      apiKey: cfg.openai_api_key,
      model: taskCfg.model || cfg.openai_model || 'gpt-4o-mini',
      prompt, timeoutMs,
    });
  }
  // CLI providers
  const bin = cfg.bins[provider] || p.defaultBin;
  const args = ['-p'];
  if (taskCfg.model && p.supportsModel) args.push('--model', taskCfg.model);
  if (tools && p.supportsTools) args.push('--allowedTools', tools.join(','));
  return runCli({ bin, args, prompt, timeoutMs, label: provider });
}

function runCli({ bin, args, prompt, timeoutMs, label }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
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
      else resolve(stdout);
    });
    child.stdin.end(prompt, 'utf8');
  });
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
