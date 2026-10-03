/**
 * 取得済みコミットの JSON キャッシュ。 再実行で GitHub への詳細取得を繰り返さないために使う。
 * コミットの変更行数は確定値なので、 sha が同じなら上書きしない。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CommitVolume } from './types.js';

const CACHE_VERSION = 2;

interface CacheFile {
  version: typeof CACHE_VERSION;
  commits: CommitVolume[];
}

export class CommitVolumeCache {
  private readonly map = new Map<string, CommitVolume>();

  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    const json = JSON.parse(readFileSync(path, 'utf8')) as Partial<CacheFile>;
    // 旧版 (ファイル内訳なし) は読み捨てて取り直す
    if (json.version !== CACHE_VERSION) return;
    for (const c of json.commits ?? []) this.map.set(c.sha, c);
  }

  has(sha: string): boolean {
    return this.map.has(sha);
  }

  get(sha: string): CommitVolume | undefined {
    return this.map.get(sha);
  }

  put(c: CommitVolume): void {
    this.map.set(c.sha, c);
  }

  all(): CommitVolume[] {
    return [...this.map.values()];
  }

  /** 一時ファイルに書いてから置き換える (途中で落ちても既存キャッシュを壊さない)。 */
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const body: CacheFile = { version: CACHE_VERSION, commits: this.all() };
    writeFileSync(tmp, JSON.stringify(body), 'utf8');
    renameSync(tmp, this.path);
  }
}
