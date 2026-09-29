import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { parseClaudeLog } from './claude-log-parser.js';
import { parseCodexLog } from './codex-log-parser.js';
import type { LlmProvider, ParsedUsageSource, SourceSignature } from './types.js';

/**
 * Bump when parsing changes what a log yields. Sources imported by an older
 * parser are re-read even though their mtime / size did not change.
 */
export const PARSER_VERSION = 2;

export interface NativeLogRoot { path: string; provider: LlmProvider }

export function defaultNativeLogRoots(): NativeLogRoot[] {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  return [
    { path: join(homedir(), '.claude', 'projects'), provider: 'claude-code' },
    { path: join(codexHome, 'sessions'), provider: 'codex-cli' },
    // Codex moves finished rollouts here; skipping it silently lost their usage.
    { path: join(codexHome, 'archived_sessions'), provider: 'codex-cli' },
  ];
}

export async function listRecentNativeLogs(
  cutoffMs: number,
  roots: NativeLogRoot[] = defaultNativeLogRoots(),
): Promise<SourceSignature[]> {
  const out: SourceSignature[] = [];
  for (const root of roots) await collectRecent(root.path, root.provider, cutoffMs, out);
  return out.sort((a, b) => a.modifiedMs - b.modifiedMs || a.path.localeCompare(b.path));
}

export async function parseNativeLog(
  source: SourceSignature,
  cutoffMs = Number.NEGATIVE_INFINITY,
): Promise<ParsedUsageSource> {
  return source.provider === 'claude-code'
    ? parseClaudeLog(source.path, cutoffMs)
    : parseCodexLog(source.path, cutoffMs);
}

async function collectRecent(
  root: string,
  provider: LlmProvider,
  cutoffMs: number,
  out: SourceSignature[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // A provider that has never run has no native log root.
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectRecent(path, provider, cutoffMs, out);
      continue;
    }
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.jsonl') continue;
    try {
      const info = await stat(path);
      if (info.mtimeMs >= cutoffMs) {
        out.push({ path, provider, modifiedMs: info.mtimeMs, sizeBytes: info.size });
      }
    } catch {
      // The provider may rotate a file while discovery runs; the next sync will retry it.
    }
  }
}
