// agent-dispatch.js — Memoria task → AI agent (Claude Code / Codex / Gemini) を
// プロジェクトディレクトリで non-interactive に走らせ、stdout/stderr を log
// ファイルにストリーム保存しながら DB の `agent_runs` 行を更新する。
//
// 既存の `runLlm` (server/llm.js) は短い LLM 質問用 (タイムアウト 3 分、結果を
// 文字列で返す) なのでこちらの長尺・1 ショット実装用とは分けて持つ。
//
// Usage:
//   const runId = startAgentRun(db, { task, project, agent });
//   // returns immediately. The child runs in the background and updates
//   // agent_runs by id when it exits.

import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import {
  insertAgentRun, updateAgentRun, getAgentRun, getTask, recordActivityEvent,
} from './db.js';

const SUPPORTED_AGENTS = new Set(['claude_code', 'codex', 'gemini']);

// Track running children by run id so cancel() can find them.
const _running = new Map();

function ensureLogDir(dataDir) {
  const dir = join(dataDir, 'agent_logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function buildPrompt({ task, project }) {
  const rules = (project.rules || '').trim();
  const lines = [
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

function buildArgs(agent) {
  if (agent === 'codex') {
    return [
      'exec',
      '--json',
      '--color', 'never',
      '--ask-for-approval', 'never',
      '--sandbox', 'workspace-write',
      '-',
    ];
  }
  if (agent === 'gemini') {
    return ['-p'];
  }
  // claude_code (default)
  return ['-p', '--dangerously-skip-permissions'];
}

function binaryFor(agent, settings) {
  if (agent === 'codex') return settings['llm.bin.codex'] || 'codex';
  if (agent === 'gemini') return settings['llm.bin.gemini'] || 'gemini';
  return settings['llm.bin.claude'] || 'claude';
}

/**
 * Start an agent run. Returns the new run id immediately. The child process
 * runs in the background and updates the DB row when it exits.
 *
 * Args:
 *   db          — better-sqlite3 instance
 *   dataDir     — base data directory (logs go to dataDir/agent_logs/)
 *   settings    — getAppSettings(db) result; used for `llm.bin.*` overrides
 *   task        — { id, title, details, due_at }
 *   project     — { id, name, path, rules, default_agent }
 *   agent       — 'claude_code' | 'codex' | 'gemini'  (overrides project.default_agent)
 *   gitBashPath — optional CLAUDE_CODE_GIT_BASH_PATH override
 *   timeoutMs   — kill the child after this many ms (default 30 min)
 */
export function startAgentRun(db, { dataDir, settings, task, project, agent, gitBashPath, timeoutMs = 30 * 60 * 1000 }) {
  if (!task) throw new Error('task required');
  if (!project) throw new Error('project required');
  const a = agent || project.default_agent || 'claude_code';
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

  const runId = insertAgentRun(db, {
    task_id: task.id,
    project_id: project.id,
    agent: a,
    prompt,
    status: 'pending',
    log_path: logFile,
  });

  // Spawn after row exists so we always have a record even if spawn fails.
  let child;
  const bin = binaryFor(a, settings || {});
  const args = buildArgs(a);
  const env = { ...process.env };
  if (a === 'claude_code' && (gitBashPath || settings?.['runtime.git_bash_path'])) {
    env.CLAUDE_CODE_GIT_BASH_PATH = gitBashPath || settings['runtime.git_bash_path'];
  }
  const stream = createWriteStream(logPath, { flags: 'a' });
  stream.write(`# agent: ${a}\n# bin: ${bin}\n# args: ${JSON.stringify(args)}\n# cwd: ${project.path}\n# started: ${new Date().toISOString()}\n# task: ${task.title}\n\n----- prompt -----\n${prompt}\n----- output -----\n`);

  try {
    child = spawn(bin, args, {
      cwd: project.path,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env,
    });
  } catch (e) {
    updateAgentRun(db, runId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      summary: `spawn failed: ${e.message}`,
    });
    stream.write(`\n----- spawn error -----\n${e.message}\n`);
    stream.end();
    return runId;
  }

  updateAgentRun(db, runId, { status: 'running', pid: child.pid });
  _running.set(runId, child);

  recordActivityEvent(db, {
    kind: 'task_updated',
    content: `[AI実装開始] ${task.title} (${a})`,
    metadata: { agent_run_id: runId, agent: a, project: project.name },
  });

  let timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
  }, timeoutMs);

  child.stdout.on('data', (d) => stream.write(d));
  child.stderr.on('data', (d) => {
    stream.write(`[stderr] `);
    stream.write(d);
  });
  child.on('error', (err) => {
    stream.write(`\n----- error -----\n${err.message}\n`);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    _running.delete(runId);
    const finishedAt = new Date().toISOString();
    let summary = '';
    try {
      const tail = readFileSync(logPath, 'utf8').slice(-2000);
      const lines = tail.split('\n').filter(l => l.trim()).slice(-6);
      summary = lines.join('\n').slice(-600);
    } catch {}
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
      content: `[AI実装${code === 0 ? '完了' : '失敗'}] ${task.title}`,
      metadata: { agent_run_id: runId, exit_code: code },
    });
  });

  // long prompt is passed via stdin (per Windows ENAMETOOLONG handling).
  child.stdin.end(prompt, 'utf8');
  return runId;
}

export function cancelAgentRun(db, runId) {
  const child = _running.get(runId);
  if (!child) return { ok: false, error: 'not_running' };
  try { child.kill('SIGKILL'); } catch (e) {
    return { ok: false, error: e.message };
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
export function readAgentRunLog(dataDir, run, { tail = 64 * 1024 } = {}) {
  if (!run?.log_path) return '';
  const path = join(dataDir, 'agent_logs', run.log_path);
  if (!existsSync(path)) return '';
  const stat = statSync(path);
  const len = Math.min(stat.size, Number(tail) || 64 * 1024);
  const buf = readFileSync(path);
  return buf.subarray(buf.length - len).toString('utf8');
}

export function isRunning(runId) {
  return _running.has(runId);
}
