import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './llm-cli.js';
import { readBoundedBytes } from './public-fetch.js';
import { contract } from '../shared/contract-runtime.js'; /* augur-inject:import:9ec59306 */
import augurContract_1886dd6d from '../../augur/contracts/security-summary.contract.js'; /* augur-inject:contract-predicate:85f9b17c */

export function textSummaryArgs(model: string): string[] {
  return ['-p', '--model', model, '--tools', '', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--settings', '{"disableAllHooks":true}', '--no-session-persistence'];
}
// @ts-expect-error augur-inject
textSummaryArgs = contract(textSummaryArgs, { ...augurContract_1886dd6d, contractId: 'C-10', mode: 'observe', sample: 1, where: 'server/shared/text-summary.ts:7', rule: 'contract-wrap', id: '1886dd6d' }); /* augur-inject:contract-wrap:1886dd6d */

/** Only runtime essentials and the dedicated summary credential reach the child. */
export function textSummaryEnvironment(source: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
  if (!source.MEMORIA_SUMMARY_CLAUDE_TOKEN) throw new Error('MEMORIA_SUMMARY_CLAUDE_TOKEN is required');
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'CLAUDE_CODE_GIT_BASH_PATH']) {
    if (source[key]) env[key] = source[key];
  }
  return { ...env, HOME: directory, USERPROFILE: directory, APPDATA: directory,
    LOCALAPPDATA: directory, TMP: directory, TEMP: directory,
    CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_OAUTH_TOKEN: source.MEMORIA_SUMMARY_CLAUDE_TOKEN };
}

// Memoria is single-owner. All ingestion credentials share this owner's bounded budget.
let active = 0;
let starts: number[] = [];
export async function withSummaryBudget<T>(prompt: string, run: () => Promise<T>, now = Date.now()): Promise<T> {
  starts = starts.filter((at) => now - at < 60_000);
  if (prompt.length > 40_000) throw new Error('summary input exceeds 40000 characters');
  if (active >= 2 || starts.length >= 10) throw new Error('summary budget exhausted; retry later');
  active += 1;
  starts.push(now);
  try { return await run(); } finally { active -= 1; }
}

export interface TextSummaryOptions {
  provider: string;
  model: string;
  bin: string;
  baseUrl: string;
  prompt: string;
  timeoutMs: number;
}

export interface TextSummaryDependencies {
  fetch?: typeof fetch;
  runCli?: typeof runCli;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
}

export async function runTextSummary(options: TextSummaryOptions, deps: TextSummaryDependencies = {}): Promise<string> {
  const environment = deps.environment ?? process.env;
  return withSummaryBudget(options.prompt, async () => {
    const timeoutMs = Math.min(options.timeoutMs, 180_000);
    if (options.provider === 'openai' || options.provider === 'gamma') {
      const apiKey = environment.MEMORIA_SUMMARY_API_KEY;
      if (options.provider === 'openai' && !apiKey) throw new Error('MEMORIA_SUMMARY_API_KEY is required');
      const url = new URL(`${options.baseUrl.replace(/\/+$/, '')}/chat/completions`);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid summary API URL');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await (deps.fetch ?? fetch)(url, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model: options.model, messages: [{ role: 'user', content: options.prompt }], max_tokens: 4096 }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`summary API returned HTTP ${response.status}`);
        }
        const data = JSON.parse(new TextDecoder().decode(await readBoundedBytes(response, 1024 * 1024))) as {
          choices?: { message?: { content?: string; tool_calls?: unknown[] } }[];
        };
        const message = data.choices?.[0]?.message;
        if (message?.tool_calls?.length) throw new Error('summary API returned forbidden tool calls');
        if (typeof message?.content !== 'string' || !message.content.trim()) throw new Error('empty summary response');
        return message.content;
      } finally { clearTimeout(timer); }
    }
    if (options.provider !== 'claude') throw new Error(`tool-less summary provider unsupported: ${options.provider}`);
    // Check the required credential before allocating resources or spawning a process.
    if (!environment.MEMORIA_SUMMARY_CLAUDE_TOKEN) throw new Error('MEMORIA_SUMMARY_CLAUDE_TOKEN is required');
    const directory = await mkdtemp(join(tmpdir(), 'memoria-summary-'));
    try {
      return await (deps.runCli ?? runCli)({ bin: options.bin, args: textSummaryArgs(options.model),
        prompt: options.prompt, timeoutMs, env: textSummaryEnvironment(environment, directory),
        cwd: directory, label: 'claude', maxOutputBytes: 1024 * 1024 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, (deps.now ?? Date.now)());
}
