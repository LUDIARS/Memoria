import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { object, text, type JsonObject } from './jsonl.js';

export interface ProjectAttribution {
  key: string;
  name: string;
  source: 'declared-project' | 'repository';
}

/** Only structured session declarations and repository ownership count, not mentions in prose. */
export class ProjectAttributor {
  private declared: ProjectAttribution | null = null;
  private hasDeclaration = false;
  private readonly cache = new Map<string, ProjectAttribution | null>();

  observe(row: JsonObject): void {
    const payload = object(row.payload);
    const message = object(row.message);
    const isClaudeUser = row.type === 'user';
    const isCodexUser = row.type === 'response_item' && payload?.type === 'message' && payload.role === 'user';
    const content = isClaudeUser ? message?.content : isCodexUser ? payload?.content : null;
    const body = typeof content === 'string' ? content : Array.isArray(content)
      ? content.map((item) => text(object(item)?.text) ?? '').join('\n') : '';
    for (const match of body.matchAll(/(?:^|\n)\[Cc policy update\]([\s\S]*?)(?=\[Cc policy revision:|\n\[Cc policy update\]|$)/g)) {
      const policy = match[1];
      if (policy.includes('前版の対象固有案内は無効')) {
        this.declared = null;
        this.hasDeclaration = false;
      }
      const root = policy.match(/^projectRoot:[ \t]*(.+)$/m)?.[1]
        ?? policy.match(/^repo:[ \t]*(.+)$/m)?.[1];
      if (root) {
        this.declared = this.identify(root.trim(), true);
        this.hasDeclaration = true;
      }
    }
  }

  current(cwd: string | null): ProjectAttribution | null {
    return this.hasDeclaration ? this.declared : (cwd ? this.identify(cwd, false) : null);
  }

  private identify(path: string, declared: boolean): ProjectAttribution | null {
    const cacheKey = `${declared}:${path}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey) ?? null;
    const root = repositoryRoot(path) ?? (declared && absolutePath(path) && !/[\\/]\.wt-/.test(path) ? path : null);
    const value = root ? projectIdentity(root, declared ? 'declared-project' : 'repository') : null;
    this.cache.set(cacheKey, value);
    return value;
  }
}

function absolutePath(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path);
}

/** Resolve linked worktrees through Git's own commondir metadata; never guess from folder names. */
function repositoryRoot(path: string): string | null {
  if (!absolutePath(path) || !existsSync(path)) return null;
  let directory = resolve(path);
  for (let depth = 0; depth < 32; depth += 1) {
    const marker = join(directory, '.git');
    try {
      if (existsSync(marker)) {
        if (statSync(marker).isDirectory()) return directory;
        const gitdir = readFileSync(marker, 'utf8').trim().match(/^gitdir:\s*(.+)$/)?.[1];
        if (!gitdir) return null;
        const gitPath = resolve(directory, gitdir);
        const commonFile = join(gitPath, 'commondir');
        if (!existsSync(commonFile)) return directory;
        const common = resolve(gitPath, readFileSync(commonFile, 'utf8').trim());
        return basename(common) === '.git' ? dirname(common) : directory;
      }
    } catch {
      // Unavailable/deleted repositories remain unassigned unless explicitly declared.
      return null;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function projectIdentity(root: string, source: ProjectAttribution['source']): ProjectAttribution {
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const identity = /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
  return {
    key: createHash('sha256').update(identity).digest('hex').slice(0, 24),
    name: normalized.split('/').at(-1) || '未判定',
    source,
  };
}
