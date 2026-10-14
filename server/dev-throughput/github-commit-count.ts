// GitHub のコミット検索で「ある JST の 1 日に org の既定ブランチへ載ったコミット件数」を数える adapter。
// 検索は total_count だけ使うので 1 日 1 リクエスト (per_page=1)。 検索 API は認証時 30 回/分。

import { jstDayRange } from './jst-day.js';
import type { FetchLike } from './revisor-merges.js';

export class GithubRateLimitError extends Error {}

export interface CommitCountDeps {
  org: string;
  token: string | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export async function countCommitsOnDay(day: string, deps: CommitCountDeps): Promise<number> {
  const query = `org:${deps.org} committer-date:${jstDayRange(day)}`;
  const url = `https://api.github.com/search/commits?per_page=1&q=${encodeURIComponent(query)}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'memoria-dev-throughput',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (deps.token) headers.Authorization = `Bearer ${deps.token}`;
  const fetchImpl = deps.fetchImpl ?? ((target, init) => fetch(target, init));
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000) });
  if (response.status === 403 || response.status === 429) throw new GithubRateLimitError(`GitHub の検索が上限に達しました (HTTP ${response.status})`);
  if (!response.ok) throw new Error(`GitHub が HTTP ${response.status} を返しました`);
  const body = await response.json() as { total_count?: unknown; incomplete_results?: unknown };
  if (typeof body.total_count !== 'number') throw new Error('GitHub の検索結果に total_count がありません');
  if (body.incomplete_results === true) throw new Error(`GitHub の検索が途中で打ち切られました (${day})`);
  return body.total_count;
}
