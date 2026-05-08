// agent-dispatch.ts — Memoria task → AI agent (Claude Code / Codex / Gemini) を
// プロジェクトディレクトリで non-interactive に走らせ、stdout/stderr を log
// ファイルにストリーム保存しながら DB の `agent_runs` 行を更新する。

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import {
  insertAgentRun, updateAgentRun, recordActivityEvent,
} from './db.js';
import type { AgentKind, AgentRunRow } from './db/types/agent.js';
import type { TaskRow } from './db/types/task.js';
import type { AgentProjectRow } from './db/types/agent.js';

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
  });

  // Spawn after row exists so we always have a record even if spawn fails.
  let child: ChildProcessWithoutNullStreams;
  const settingsObj = settings || {};
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
  });

  child.stdin.end(prompt, 'utf8');
  return runId;
}

export function cancelAgentRun(db: Db, runId: number): { ok: true } | { ok: false; error: string } {
  const child = _running.get(runId);
  if (!child) return { ok: false, error: 'not_running' };
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
