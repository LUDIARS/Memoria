/**
 * GitHub REST の adapter。 コミット検索 (本人の push 済みコミット) と 1 件ごとの変更行数取得。
 * fetch は差し替え可能にし、 rate limit (403/429) は reset 時刻まで待って再試行する。
 */
import type { AuthorIdentity, CommitVolume, FileChange } from './types.js';

const API = 'https://api.github.com';
const SEARCH_LIMIT = 1000;
const PER_PAGE = 100;
const FILES_PER_PAGE = 300;
const MAX_FILE_PAGES = 10;
const MAX_RETRIES = 4;

export type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface GithubClientOptions {
  token: string | null;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface SearchHit {
  sha: string;
  repo: string;
}

export class SearchOverflowError extends Error {
  constructor(public readonly total: number) {
    super(`search returned ${total} results (> ${SEARCH_LIMIT})`);
  }
}

interface SearchJson {
  total_count?: number;
  items?: { sha?: string; repository?: { full_name?: string } }[];
}

interface CommitJson {
  sha?: string;
  commit?: { author?: { date?: string } };
  stats?: { additions?: number; deletions?: number };
  files?: { filename?: string; additions?: number; deletions?: number }[];
}

export function authorQualifier(a: AuthorIdentity): string {
  return a.kind === 'login' ? `author:${a.value}` : `author-email:${a.value}`;
}

export function createGithubCommitClient(opts: GithubClientOptions) {
  const doFetch: Fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'memoria-code-volume',
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  async function getJson(url: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, { headers });
      if (res.status === 200) return res.json();
      const limited = res.status === 429
        || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')
        || (res.status === 403 && res.headers.get('retry-after') != null);
      if (!limited || attempt >= MAX_RETRIES) throw new Error(`GitHub ${res.status}: ${url}`);
      const retryAfter = Number(res.headers.get('retry-after'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const waitMs = retryAfter > 0
        ? retryAfter * 1000
        : reset > 0 ? Math.max(1000, reset * 1000 - now() + 1000) : 60_000;
      await sleep(waitMs);
    }
  }

  /** 1 つの日付窓で本人のコミットを引く。 1000 件を超えたら SearchOverflowError (呼び手が窓を割る)。 */
  async function searchCommits(author: AuthorIdentity, from: string, to: string): Promise<SearchHit[]> {
    const q = `${authorQualifier(author)} author-date:${from}..${to} merge:false`;
    const hits: SearchHit[] = [];
    for (let page = 1; ; page++) {
      const url = `${API}/search/commits?q=${encodeURIComponent(q)}&per_page=${PER_PAGE}&page=${page}&sort=author-date&order=asc`;
      const json = await getJson(url) as SearchJson;
      const total = json.total_count ?? 0;
      if (total > SEARCH_LIMIT) throw new SearchOverflowError(total);
      for (const it of json.items ?? []) {
        if (it.sha && it.repository?.full_name) hits.push({ sha: it.sha, repo: it.repository.full_name });
      }
      if ((json.items?.length ?? 0) < PER_PAGE || hits.length >= total) return hits;
    }
  }

  /** 1 コミットの変更行数とファイル別の内訳。 ファイル一覧はページを辿り、 上限で切れたら filesTruncated を立てる。 */
  async function fetchCommitVolume(hit: SearchHit): Promise<CommitVolume> {
    let additions = 0, deletions = 0;
    const changes: FileChange[] = [];
    let authoredAt = '';
    let truncated = false;
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const json = await getJson(`${API}/repos/${hit.repo}/commits/${hit.sha}?per_page=${FILES_PER_PAGE}&page=${page}`) as CommitJson;
      if (page === 1) {
        authoredAt = json.commit?.author?.date ?? '';
        additions = json.stats?.additions ?? 0;
        deletions = json.stats?.deletions ?? 0;
      }
      const files = json.files ?? [];
      for (const f of files) {
        if (f.filename) changes.push({ path: f.filename, additions: f.additions ?? 0, deletions: f.deletions ?? 0 });
      }
      if (files.length < FILES_PER_PAGE) break;
      if (page === MAX_FILE_PAGES) truncated = true;
    }
    if (!authoredAt) throw new Error(`commit without author date: ${hit.repo}@${hit.sha}`);
    return { sha: hit.sha, repo: hit.repo, authoredAt, additions, deletions, files: changes, filesTruncated: truncated };
  }

  return { searchCommits, fetchCommitVolume };
}

export type GithubCommitClient = ReturnType<typeof createGithubCommitClient>;
