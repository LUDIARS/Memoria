import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnOneShot } from '@ludiars/one-shot';

export function runCli({
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
      child = (label === 'claude' || label === 'codex' ? spawnOneShot : spawn)(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env });
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

export function extractCodexLastMessage(raw: string): string {
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

