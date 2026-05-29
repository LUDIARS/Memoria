// agent-dispatch.ts — Memoria task → AI agent (Claude Code / Codex / Gemini) を
// プロジェクトディレクトリで non-interactive に走らせ、stdout/stderr を log
// ファイルにストリーム保存しながら DB の `agent_runs` 行を更新する。
//
// 設定 `llm.task_runner` で動作モードを切り替える (spec/feature/concordia-runner.md):
//   - 'local'    (default): child_process.spawn で CLI を non-interactive 起動
//   - 'concordia':         Concordia /v1/spawn 経由で wt タブ起動 + inject

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { forwardToConcordia } from './concordia-forward.js';
import {
  insertAgentRun, updateAgentRun, recordActivityEvent,
} from './db.js';
import type { AgentKind, AgentRunRow } from './db/types/agent.js';
import type { TaskRow } from './db/types/task.js';
import type { AgentProjectRow } from './db/types/agent.js';
import { ConcordiaSpawnClient, type ConcordiaProvider } from './concordia-spawn-client.js';

type Db = BetterSqlite3.Database;

const SUPPORTED_AGENTS = new Set<AgentKind>(['claude_code', 'codex', 'gemini']);

const _running = new Map<number, ChildProcessWithoutNullStreams>();

function ensureLogDir(dataDir: string): string {
  const dir = join(dataDir, 'agent_logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function buildPrompt({ task, project }: { task: TaskRow; project: AgentProjectRow }): string {
  const rules = (project.rules || '').trim();
  const lines: string[] = [
    `あなたはこのプロジェクトのコードを 1 ショットで実装するエージェントです。`,
    `止まらず最後まで実装し、完了したらサマリを 1 行出力して終了してください。`,
    '',
    `## プロジェクト: ${project.name}`,
    `パス: ${project.path}`,
    '',
  ];
  if (rules) {
    lines.push('## ルール');
    lines.push(rules);
    lines.push('');
  }
  lines.push('## タスク');
  lines.push(`タイトル: ${task.title}`);
  if (task.due_at) lines.push(`期日: ${task.due_at}`);
  lines.push('');
  if (task.details) {
    lines.push('## 詳細');
    lines.push(task.details);
    lines.push('');
  }
  lines.push('## 実行ガイド');
  lines.push('- 不明点があればまずコードを読んで判断する (質問せず先に進む)');
  lines.push('- ローカルテスト・型チェック・lint があれば実行する');
  lines.push('- 完了時にやった作業の要約を 3〜5 行で出力する');
  return lines.join('\n');
}

const AGENT_DEFAULT_MODEL: Record<AgentKind, string> = {
  claude_code: 'sonnet',
  codex:       '5.3-codex',
  gemini:      'gemini-2.5-flash',
};

function buildArgs(agent: AgentKind, model: string | null | undefined): string[] {
  const m = (model && String(model).trim()) || AGENT_DEFAULT_MODEL[agent] || '';
  if (agent === 'codex') {
    const args: string[] = [
      'exec',
      '--json',
      '--color', 'never',
      '--ask-for-approval', 'never',
      '--sandbox', 'workspace-write',
    ];
    if (m) args.push('--model', m);
    args.push('-');
    return args;
  }
  if (agent === 'gemini') {
    const args: string[] = [];
    if (m) args.push('-m', m);
    args.push('-p');
    return args;
  }
  // claude_code (default)
  const args: string[] = ['-p', '--dangerously-skip-permissions'];
  if (m) args.push('--model', m);
  return args;
}

function binaryFor(agent: AgentKind, settings: Record<string, string | null | undefined>): string {
  if (agent === 'codex') return settings['llm.bin.codex'] || 'codex';
  if (agent === 'gemini') return settings['llm.bin.gemini'] || 'gemini';
  return settings['llm.bin.claude'] || 'claude';
}

export interface StartAgentRunArgs {
  dataDir: string;
  settings?: Record<string, string | null | undefined>;
  task: TaskRow;
  project: AgentProjectRow;
  agent?: AgentKind;
  model?: string | null;
  gitBashPath?: string | null;
  timeoutMs?: number;
}

/**
 * Start an agent run. Returns the new run id immediately. The child process
 * runs in the background and updates the DB row when it exits.
 *
 * Dispatches by `settings['llm.task_runner']` (spec/feature/concordia-runner.md):
 *   - 'local' or unset → local spawn (this function continues below)
 *   - 'concordia'      → delegate to startConcordiaRun (wt tab + Lictor inject)
 */
export function startAgentRun(
  db: Db,
  { dataDir, settings, task, project, agent, model, gitBashPath, timeoutMs = 30 * 60 * 1000 }: StartAgentRunArgs,
): number {
  if (!task) throw new Error('task required');
  if (!project) throw new Error('project required');
  const a: AgentKind = (agent || project.default_agent || 'claude_code') as AgentKind;
  if (!SUPPORTED_AGENTS.has(a)) throw new Error(`unsupported agent: ${a}`);
  if (!project.path || !isAbsolute(project.path)) {
    throw new Error('project.path must be an absolute path');
  }
  if (!existsSync(project.path)) {
    throw new Error(`project.path does not exist: ${project.path}`);
  }
  const settingsObj = settings || {};
  const runner = (settingsObj['llm.task_runner'] || 'local').trim().toLowerCase();
  if (runner === 'concordia') {
    return startConcordiaRun(db, { dataDir, settings: settingsObj, task, project, agent: a, model });
  }
  if (runner !== 'local' && runner !== '') {
    throw new Error(`unknown llm.task_runner: ${runner} (expected 'local' or 'concordia')`);
  }
  const logDir = ensureLogDir(dataDir);
  const logFile = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.log`;
  const logPath = join(logDir, logFile);
  const prompt = buildPrompt({ task, project });
  const effectiveModel = (model && String(model).trim()) || AGENT_DEFAULT_MODEL[a] || '';

  const runId = insertAgentRun(db, {
    task_id: task.id,
    project_id: project.id,
    agent: a,
    model: effectiveModel || null,
    prompt,
    status: 'pending',
    log_path: logFile,
    mode: 'local',
  });

  // Spawn after row exists so we always have a record even if spawn fails.
  let child: ChildProcessWithoutNullStreams;
  const bin = binaryFor(a, settingsObj);
  const args = buildArgs(a, effectiveModel);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (a === 'claude_code' && (gitBashPath || settingsObj['runtime.git_bash_path'])) {
    env.CLAUDE_CODE_GIT_BASH_PATH = gitBashPath || settingsObj['runtime.git_bash_path'] || '';
  }
  const stream = createWriteStream(logPath, { flags: 'a' });
  stream.write(`# agent: ${a}\n# model: ${effectiveModel || '(default)'}\n# bin: ${bin}\n# args: ${JSON.stringify(args)}\n# cwd: ${project.path}\n# started: ${new Date().toISOString()}\n# task: ${task.title}\n\n----- prompt -----\n${prompt}\n----- output -----\n`);

  try {
    child = spawn(bin, args, {
      cwd: project.path,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    updateAgentRun(db, runId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      summary: `spawn failed: ${msg}`,
    });
    stream.write(`\n----- spawn error -----\n${msg}\n`);
    stream.end();
    return runId;
  }

  updateAgentRun(db, runId, { status: 'running', pid: child.pid });
  _running.set(runId, child);

  recordActivityEvent(db, {
    kind: 'task_updated',
    occurred_at: undefined,
    source: undefined,
    ref_id: undefined,
    content: `[AI実装開始] ${task.title} (${a}${effectiveModel ? `:${effectiveModel}` : ''})`,
    metadata: { agent_run_id: runId, agent: a, model: effectiveModel || null, project: project.name },
  });

  const dispatchStartedAt = Date.now();
  forwardToConcordia({
    kind: 'llm-request',
    task: `agent-dispatch:${task.title}`,
    provider: a,
    model: effectiveModel || undefined,
    text: prompt,
  });

  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }, timeoutMs);

  child.stdout.on('data', (d: Buffer) => stream.write(d));
  child.stderr.on('data', (d: Buffer) => {
    stream.write(`[stderr] `);
    stream.write(d);
  });
  child.on('error', (err: Error) => {
    stream.write(`\n----- error -----\n${err.message}\n`);
  });
  child.on('close', (code: number | null) => {
    clearTimeout(timer);
    _running.delete(runId);
    const finishedAt = new Date().toISOString();
    let summary = '';
    try {
      const tail = readFileSync(logPath, 'utf8').slice(-2000);
      const lines = tail.split('\n').filter(l => l.trim()).slice(-6);
      summary = lines.join('\n').slice(-600);
    } catch { /* ignore */ }
    stream.write(`\n----- finished -----\nexit: ${code}\nat: ${finishedAt}\n`);
    stream.end();
    updateAgentRun(db, runId, {
      status: code === 0 ? 'done' : 'failed',
      exit_code: code,
      finished_at: finishedAt,
      summary,
    });
    recordActivityEvent(db, {
      kind: code === 0 ? 'task_done' : 'task_updated',
      occurred_at: undefined,
      source: undefined,
      ref_id: undefined,
      content: `[AI実装${code === 0 ? '完了' : '失敗'}] ${task.title}`,
      metadata: { agent_run_id: runId, exit_code: code },
    });
    forwardToConcordia({
      kind: code === 0 ? 'llm-response' : 'llm-error',
      task: `agent-dispatch:${task.title}`,
      provider: a,
      model: effectiveModel || undefined,
      text: code === 0 ? (summary || `exit=${code}`) : `exit=${code} ${summary}`,
      durationMs: Date.now() - dispatchStartedAt,
    });
  });

  child.stdin.end(prompt, 'utf8');
  return runId;
}

/**
 * Concordia /v1/spawn 経路で AI 委託する。 spec/feature/concordia-runner.md。
 *
 * 流れ (失敗時は agent_runs.status=failed + summary に原因、 local fallback はしない):
 *   1. agent_runs を mode='concordia' / status='pending' で insert
 *   2. Concordia /v1/spawn/info → token → /v1/spawn でwtタブ起動
 *   3. /v1/sessions?status=active を poll して session_id を発見
 *   4. /v1/sessions/:id/inject で prompt を流し込む
 *   5. status='running' + concordia_session_id をセット
 *
 * non-blocking: spawn → poll → inject は async で進めつつ run id は即返す。
 */
export function startConcordiaRun(
  db: Db,
  { dataDir, settings, task, project, agent, model }: {
    dataDir: string;
    settings: Record<string, string | null | undefined>;
    task: TaskRow;
    project: AgentProjectRow;
    agent: AgentKind;
    model?: string | null;
  },
): number {
  const logDir = ensureLogDir(dataDir);
  const logFile = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.log`;
  const logPath = join(logDir, logFile);
  const prompt = buildPrompt({ task, project });
  const effectiveModel = (model && String(model).trim()) || AGENT_DEFAULT_MODEL[agent] || '';
  const concordiaUrl = (settings['llm.concordia.url'] || 'http://127.0.0.1:17330').trim();

  const runId = insertAgentRun(db, {
    task_id: task.id,
    project_id: project.id,
    agent,
    model: effectiveModel || null,
    prompt,
    status: 'pending',
    log_path: logFile,
    mode: 'concordia',
  });

  const stream = createWriteStream(logPath, { flags: 'a' });
  stream.write(
    `# mode: concordia\n# agent: ${agent}\n# model: ${effectiveModel || '(default)'}\n` +
    `# concordia: ${concordiaUrl}\n# cwd: ${project.path}\n# started: ${new Date().toISOString()}\n` +
    `# task: ${task.title}\n\n----- prompt (will be injected) -----\n${prompt}\n----- events -----\n`,
  );

  recordActivityEvent(db, {
    kind: 'task_updated',
    occurred_at: undefined,
    source: undefined,
    ref_id: undefined,
    content: `[AI実装開始/Concordia] ${task.title} (${agent}${effectiveModel ? `:${effectiveModel}` : ''})`,
    metadata: { agent_run_id: runId, agent, model: effectiveModel || null, project: project.name, mode: 'concordia' },
  });

  // fire-and-forget. errors land in the log + agent_runs row.
  void runConcordiaFlow({ runId, agent, project, prompt, concordiaUrl, stream, task })
    .catch((err: Error) => {
      stream.write(`\n----- unhandled error -----\n${err.message}\n${err.stack ?? ''}\n`);
      stream.end();
      updateAgentRun(db, runId, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        summary: `concordia flow crashed: ${err.message}`.slice(0, 600),
      });
    });

  async function runConcordiaFlow(input: {
    runId: number;
    agent: AgentKind;
    project: AgentProjectRow;
    prompt: string;
    concordiaUrl: string;
    stream: ReturnType<typeof createWriteStream>;
    task: TaskRow;
  }): Promise<void> {
    const { runId, agent, project, prompt, concordiaUrl, stream, task } = input;
    const client = new ConcordiaSpawnClient({ url: concordiaUrl });
    const concordiaProvider = agentKindToConcordiaProvider(agent);
    const spawnStartedAtSec = Math.floor(Date.now() / 1000) - 2; // -2s grace for clock skew

    // 2. spawn
    stream.write(`[${new Date().toISOString()}] spawn → ${client.baseUrl}/v1/spawn\n`);
    let spawnResult;
    try {
      spawnResult = await client.spawn({
        provider: concordiaProvider,
        cwd: project.path,
        mode: 'tab',
        title: `Memoria/${project.name}/${task.title.slice(0, 40)}`,
      });
    } catch (e) {
      const msg = (e as Error).message;
      stream.write(`[spawn error] ${msg}\n`);
      stream.end();
      updateAgentRun(db, runId, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        summary: `spawn failed: ${msg}`.slice(0, 600),
      });
      return;
    }
    stream.write(`[spawn ok] id=${spawnResult.id} pid=${spawnResult.pid}\n`);
    updateAgentRun(db, runId, { pid: spawnResult.pid });

    // 3. session_id discovery
    const sessionId = await client.waitForSession({
      provider: concordiaProvider,
      repoPath: project.path,
      minStartedAtSec: spawnStartedAtSec,
    });
    if (!sessionId) {
      stream.write(`[session not detected within 30s]\n`);
      stream.end();
      updateAgentRun(db, runId, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        summary: 'concordia session not detected within 30s',
      });
      return;
    }
    stream.write(`[${new Date().toISOString()}] session detected: ${sessionId}\n`);
    updateAgentRun(db, runId, { concordia_session_id: sessionId });

    // 4. inject
    try {
      await client.inject({ sessionId, text: prompt, source: 'memoria-task' });
    } catch (e) {
      const msg = (e as Error).message;
      stream.write(`[inject error] ${msg}\n`);
      stream.end();
      updateAgentRun(db, runId, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        summary: `inject failed: ${msg}`.slice(0, 600),
      });
      return;
    }
    stream.write(`[${new Date().toISOString()}] inject ok — prompt delivered to ${sessionId}\n`);
    stream.write(`# wt タブで進行を確認してください。 Memoria はここで監視を打ち切り、 status='running' を残します。\n`);
    stream.end();

    // 5. We don't track exit here — the wt session is long-lived and may
    // outlive the task. Mark as 'running' and let the user observe in wt.
    updateAgentRun(db, runId, {
      status: 'running',
      summary: `concordia session ${sessionId} は wt タブで進行中`,
    });
  }

  return runId;
}

/**
 * Memoria の AgentKind → Concordia /v1/spawn の provider 短縮形 (Lictor の
 * binary 名に対応)。 Concordia 側の `provider` フィルタ値 (`claude-code`/
 * `codex-cli`/`gemini-cli`) は spawn-client の providerToConcordia で別途
 * 変換される。
 */
function agentKindToConcordiaProvider(a: AgentKind): ConcordiaProvider {
  if (a === 'codex') return 'codex';
  if (a === 'gemini') return 'gemini';
  return 'claude';
}

export function cancelAgentRun(db: Db, runId: number): { ok: true } | { ok: false; error: string } {
  const child = _running.get(runId);
  if (!child) {
    // 'concordia' モードは _running を持たない (wt タブで進行中) ので、 ここで
    // 区別する。 強制 cancel は wt タブ側で /exit してもらう運用とする。
    return { ok: false, error: 'not_running (concordia mode は wt タブで /exit してください)' };
  }
  try {
    child.kill('SIGKILL');
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  updateAgentRun(db, runId, {
    status: 'cancelled',
    finished_at: new Date().toISOString(),
  });
  return { ok: true };
}

/**
 * Read the log file for a run. `tail` controls how many bytes from the end
 * to return (default 64KiB).
 */
export function readAgentRunLog(
  dataDir: string,
  run: AgentRunRow | null | undefined,
  { tail = 64 * 1024 }: { tail?: number } = {},
): string {
  if (!run?.log_path) return '';
  const path = join(dataDir, 'agent_logs', run.log_path);
  if (!existsSync(path)) return '';
  const stat = statSync(path);
  const len = Math.min(stat.size, Number(tail) || 64 * 1024);
  const buf = readFileSync(path);
  return buf.subarray(buf.length - len).toString('utf8');
}

export function isRunning(runId: number): boolean {
  return _running.has(runId);
}
