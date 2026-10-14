// GitHub の token を探す。 MEMORIA_GH_TOKEN → GITHUB_TOKEN → `gh auth token` の順。
// 見つからなければ null (未認証で呼ぶと private リポのコミットは数に入らない)。

import { execFileSync } from 'node:child_process';

export function resolveGithubToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.MEMORIA_GH_TOKEN || env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim() || null;
  } catch {
    return null;
  }
}
