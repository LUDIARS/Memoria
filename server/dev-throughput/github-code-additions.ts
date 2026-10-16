// GitHub commit details supply additions; only complete days are published.
import { isCodeFile } from '../shared/code-file-filter.js';
import { GithubRateLimitError, type CommitCountDeps } from './github-commit-count.js';
import { jstDayRange } from './jst-day.js';

interface SearchHit { sha: string; repository: { full_name: string } }
interface FileChange { filename: string; additions: number }
export interface CodeAdditionsDeps extends CommitCountDeps {
  readCached: (repo: string, sha: string) => number | undefined;
  saveCached: (repo: string, sha: string, additions: number) => void;
  pause: () => Promise<void>;
}

export async function countCodeAdditionsOnDay(day: string, deps: CodeAdditionsDeps): Promise<number> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json', 'User-Agent': 'memoria-dev-throughput',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (deps.token) headers.Authorization = `Bearer ${deps.token}`;
  const fetchImpl = deps.fetchImpl ?? fetch;
  async function get(path: string): Promise<Response> {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers, signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000),
    });
    if (response.status === 403 || response.status === 429) throw new GithubRateLimitError(`GitHub の取得制限 (HTTP ${response.status})`);
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    return response;
  }
  async function commitAdditions(hit: SearchHit): Promise<number> {
    const repo = hit.repository.full_name;
    const cached = deps.readCached(repo, hit.sha);
    if (cached !== undefined) return cached;
    let total = 0;
    for (let page = 1; page <= 30; page++) {
      const response = await get(`/repos/${repo}/commits/${hit.sha}?per_page=100&page=${page}`);
      const body = await response.json() as { files?: FileChange[] };
      if (!Array.isArray(body.files)) throw new Error('GitHub のファイル一覧がありません');
      for (const file of body.files) {
        if (typeof file.filename !== 'string' || !Number.isSafeInteger(file.additions) || file.additions < 0) throw new Error('GitHub の追加行数が不正です');
        if (isCodeFile(file.filename)) total += file.additions;
      }
      // GitHub caps commit files at 3000. Treat an exact cap conservatively as incomplete.
      if (page === 30 && body.files.length === 100) throw new Error('GitHub のファイル数上限に達しました');
      if (!(response.headers.get('link') ?? '').includes('rel="next"')) {
        deps.saveCached(repo, hit.sha, total);
        return total;
      }
    }
    throw new Error('GitHub のファイル一覧を取得しきれませんでした');
  }
  const query = `org:${deps.org} committer-date:${jstDayRange(day)} merge:false`;
  const hits = new Map<string, SearchHit>();
  let expected: number | undefined;
  for (let page = 1; page <= 10; page++) {
    if (page > 1) await deps.pause();
    const response = await get(`/search/commits?per_page=100&page=${page}&q=${encodeURIComponent(query)}&sort=committer-date&order=asc`);
    const body = await response.json() as { total_count: number; incomplete_results: boolean; items: SearchHit[] };
    if (!Number.isSafeInteger(body.total_count) || body.total_count < 0 || !Array.isArray(body.items)) throw new Error('GitHub の検索結果が不正です');
    if (body.incomplete_results || body.total_count > 1000) throw new Error('GitHub のコミット検索が途中で打ち切られました');
    if (expected !== undefined && expected !== body.total_count) throw new Error('GitHub の検索結果が取得中に変わりました');
    expected = body.total_count;
    for (const hit of body.items) {
      if (!/^[a-f0-9]{40,64}$/i.test(hit.sha) || !/^[\w.-]+\/[\w.-]+$/.test(hit.repository?.full_name)) throw new Error('GitHub のコミット参照が不正です');
      hits.set(`${hit.repository.full_name}@${hit.sha}`, hit);
    }
    if (hits.size === expected) break;
    if (body.items.length < 100 || page === 10) throw new Error('GitHub のコミット一覧を取得しきれませんでした');
  }
  let total = 0;
  for (const hit of hits.values()) total += await commitAdditions(hit);
  return total;
}
