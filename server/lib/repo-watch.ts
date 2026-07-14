// repo_watch のソース管理プロバイダ連携。
//
// 役割は 2 つだけ:
//   1. ユーザ入力 (URL / owner/name) を { provider, owner, name, html_url } に正規化
//   2. プロバイダ API を叩いて 「PR / Issue / デフォルトブランチ最終更新」 の
//      サマリを取得 (= repo_watch のキャッシュ列に焼くための値)
//
// 内部ビューアは持たない方針なので、 ここで取るのは一覧表示に必要な
// 件数・最終コミットだけ。 詳細はすべて html_url 系リンクで元の
// ホスティング先へ飛ばす。
//
// provider は現状 'github' のみ。 GitLab / Bitbucket / Gitea などを足す時は
// PROVIDERS と fetchRepoStats の switch に分岐を追加する (DB スキーマと
// ルータは provider 非依存に書いてある)。

export type RepoProvider = 'github';

/** 実装済みプロバイダ。 UI のセレクトはここから生成する。 */
export const REPO_PROVIDERS: ReadonlyArray<{ key: RepoProvider; label: string }> = [
  { key: 'github', label: 'GitHub' },
];

export interface ParsedRepo {
  provider: RepoProvider;
  owner: string;
  name: string;
  html_url: string;
}

export interface RepoItem {
  kind: 'pr' | 'issue';
  number: number;
  title: string;
  html_url: string;
  state: string;
  author: string | null;
  updated_at: string | null;
}

export interface RepoCi {
  status: string | null;          // 'queued' | 'in_progress' | 'completed'
  conclusion: string | null;      // 'success' | 'failure' | 'cancelled' | 'skipped' | etc.
  url: string | null;
  workflow_name: string | null;
  run_at: string | null;
}

export interface RepoStats {
  default_branch: string | null;
  open_pr_count: number | null;
  open_issue_count: number | null;
  last_commit_sha: string | null;
  last_commit_message: string | null;
  last_commit_url: string | null;
  last_commit_at: string | null;
  items: RepoItem[];              // 最大 50 件、 PR + Issue 混在、 updated_at DESC
  ci: RepoCi;
  /** 取得に失敗した場合の理由 (= 部分的にしか取れなかった時も入れる)。 成功なら null。 */
  fetch_error: string | null;
}

/** 「直近の作業 サマリ」 用の最小コミット情報。 fetchRepoRecentCommits の戻り値。 */
export interface RepoCommit {
  sha: string;
  message: string;        // 1 行目だけ
  html_url: string;
  author: string | null;  // login 優先、 commit.author.name fallback
  when: string | null;    // ISO 8601
}

/** プロバイダ非依存: 直近 N コミットを取る。 失敗時は { items: [], error } を返す。 */
export async function fetchRepoRecentCommits(
  repo: { provider: string; owner: string; name: string; default_branch?: string | null },
  token: string | null,
  limit: number,
): Promise<{ items: RepoCommit[]; error: string | null }> {
  if (repo.provider === 'github') {
    return fetchGithubRecentCommits(repo.owner, repo.name, repo.default_branch ?? null, token, limit);
  }
  return { items: [], error: `未対応の provider: ${repo.provider}` };
}

/**
 * ユーザ入力を正規化する。 受け付ける形:
 *   - https://github.com/owner/name             (.git / 末尾スラッシュ / 余分なパスは無視)
 *   - github.com/owner/name
 *   - git@github.com:owner/name.git
 *   - owner/name                                 (= GitHub と見なす)
 *
 * 解釈できなければ { error } を返す。
 */
export function parseRepoInput(raw: string): ParsedRepo | { error: string } {
  const input = (raw || '').trim();
  if (!input) return { error: 'リポジトリ URL または owner/name を入力してください' };

  // git@github.com:owner/name.git
  const ssh = input.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (ssh) return makeGithub(ssh[1], ssh[2]);

  // http(s)://github.com/owner/name/...  または  github.com/owner/name
  const urlLike = input.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i);
  if (urlLike) return makeGithub(urlLike[1], urlLike[2]);

  // owner/name (スキームなし)
  const shorthand = input.match(/^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\.git)?$/);
  if (shorthand) return makeGithub(shorthand[1], shorthand[2]);

  return { error: 'GitHub の URL か owner/name 形式で入力してください' };
}

function makeGithub(owner: string, name: string): ParsedRepo {
  const o = owner.trim();
  const n = name.trim().replace(/\.git$/i, '');
  return { provider: 'github', owner: o, name: n, html_url: `https://github.com/${o}/${n}` };
}

/** provider に応じてサマリを取得する。 例外は投げず、 失敗は fetch_error に入れて返す。 */
export async function fetchRepoStats(
  repo: { provider: string; owner: string; name: string },
  token: string | null,
): Promise<RepoStats> {
  if (repo.provider === 'github') {
    return fetchGithubRepoStats(repo.owner, repo.name, token);
  }
  return { ...EMPTY_STATS, fetch_error: `未対応の provider: ${repo.provider}` };
}

const EMPTY_CI: RepoCi = {
  status: null,
  conclusion: null,
  url: null,
  workflow_name: null,
  run_at: null,
};

const EMPTY_STATS: RepoStats = {
  default_branch: null,
  open_pr_count: null,
  open_issue_count: null,
  last_commit_sha: null,
  last_commit_message: null,
  last_commit_url: null,
  last_commit_at: null,
  items: [],
  ci: EMPTY_CI,
  fetch_error: null,
};

interface GithubRepoResponse {
  default_branch?: string;
  open_issues_count?: number;   // issue + PR の合算
}
interface GithubCommitResponse {
  sha?: string;
  html_url?: string;
  commit?: { message?: string; committer?: { date?: string }; author?: { date?: string } };
}
interface GithubPullResponse {
  number?: number;
  title?: string;
  html_url?: string;
  state?: string;
  updated_at?: string;
  user?: { login?: string };
}
interface GithubIssueResponse {
  number?: number;
  title?: string;
  html_url?: string;
  state?: string;
  updated_at?: string;
  user?: { login?: string };
  pull_request?: unknown;       // Issues API は PR も返す。 これがあれば PR なので除外。
}
interface GithubActionsRunsResponse {
  workflow_runs?: Array<{
    status?: string;
    conclusion?: string | null;
    html_url?: string;
    name?: string;
    updated_at?: string;
  }>;
}

/**
 * GitHub REST v3 でリポジトリのサマリを取る。
 *   - GET /repos/{o}/{n}                      → default_branch, open_issues_count
 *   - GET /repos/{o}/{n}/commits?sha=&per_page=1 → デフォルトブランチ最終コミット
 *   - GET /search/issues?q=...is:pr is:open    → open PR 件数
 *     (Issue 件数 = open_issues_count - PR 件数。 GitHub の open_issues_count は
 *      PR も含むため)
 *
 * token があれば Authorization に載せる (rate limit 緩和 + private 対応)。
 * 無くても public repo は取得できる。
 */
async function fetchGithubRepoStats(
  owner: string,
  name: string,
  token: string | null,
): Promise<RepoStats> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Memoria-repo-watch',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const slug = `${owner}/${name}`;
  const get = async (url: string): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> => {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, error: `GitHub API ${res.status}: ${body.slice(0, 200)}` };
      }
      return { ok: true, data: await res.json() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  // 1. repo メタ — ここが落ちたら致命的 (= リポジトリ自体が見えない)。
  const repoRes = await get(`https://api.github.com/repos/${slug}`);
  if (!repoRes.ok) return { ...EMPTY_STATS, fetch_error: repoRes.error };
  const repo = repoRes.data as GithubRepoResponse;
  const defaultBranch = repo.default_branch ?? null;
  const openIssuesAndPrs = typeof repo.open_issues_count === 'number' ? repo.open_issues_count : null;

  const errors: string[] = [];

  // 2. デフォルトブランチ最終コミット (best-effort)。
  let lastCommitSha: string | null = null;
  let lastCommitMessage: string | null = null;
  let lastCommitUrl: string | null = null;
  let lastCommitAt: string | null = null;
  if (defaultBranch) {
    const commitsRes = await get(
      `https://api.github.com/repos/${slug}/commits?sha=${encodeURIComponent(defaultBranch)}&per_page=1`,
    );
    if (commitsRes.ok && Array.isArray(commitsRes.data) && commitsRes.data.length > 0) {
      const c = commitsRes.data[0] as GithubCommitResponse;
      lastCommitSha = c.sha ?? null;
      lastCommitMessage = (c.commit?.message ?? '').split('\n')[0] || null;
      lastCommitUrl = c.html_url ?? (lastCommitSha ? `https://github.com/${slug}/commit/${lastCommitSha}` : null);
      lastCommitAt = c.commit?.committer?.date ?? c.commit?.author?.date ?? null;
    } else if (!commitsRes.ok) {
      errors.push(`commits: ${commitsRes.error}`);
    }
  }

  // 3. open PR リスト (最大 50 件、 updated_at DESC)。 件数は array.length で算出。
  let openPrCount: number | null = null;
  const items: RepoItem[] = [];
  const pullsRes = await get(
    `https://api.github.com/repos/${slug}/pulls?state=open&per_page=50&sort=updated&direction=desc`,
  );
  if (pullsRes.ok && Array.isArray(pullsRes.data)) {
    const arr = pullsRes.data as GithubPullResponse[];
    openPrCount = arr.length;
    for (const p of arr) {
      if (typeof p.number !== 'number' || !p.title || !p.html_url) continue;
      items.push({
        kind: 'pr',
        number: p.number,
        title: p.title,
        html_url: p.html_url,
        state: p.state ?? 'open',
        author: p.user?.login ?? null,
        updated_at: p.updated_at ?? null,
      });
    }
  } else if (!pullsRes.ok) {
    errors.push(`pulls: ${pullsRes.error}`);
  }

  // 4. open Issue リスト (最大 50 件、 updated_at DESC)。 GitHub Issues API は PR も
  //    返すので `pull_request` フィールドがあるものは除外する。
  let openIssueCount: number | null = null;
  const issuesRes = await get(
    `https://api.github.com/repos/${slug}/issues?state=open&per_page=50&sort=updated&direction=desc`,
  );
  if (issuesRes.ok && Array.isArray(issuesRes.data)) {
    const arr = issuesRes.data as GithubIssueResponse[];
    let count = 0;
    for (const i of arr) {
      if (i.pull_request) continue;
      if (typeof i.number !== 'number' || !i.title || !i.html_url) continue;
      count++;
      items.push({
        kind: 'issue',
        number: i.number,
        title: i.title,
        html_url: i.html_url,
        state: i.state ?? 'open',
        author: i.user?.login ?? null,
        updated_at: i.updated_at ?? null,
      });
    }
    openIssueCount = count;
  } else if (!issuesRes.ok) {
    errors.push(`issues: ${issuesRes.error}`);
    // 致命的でない場合の fallback: /repos の open_issues_count (PR 込み合算)
    openIssueCount = openIssuesAndPrs != null && openPrCount != null
      ? Math.max(0, openIssuesAndPrs - openPrCount)
      : openIssuesAndPrs;
  }

  // 合算ソート: updated_at DESC (null は末尾)
  items.sort((a, b) => {
    const ta = a.updated_at || '';
    const tb = b.updated_at || '';
    if (ta === tb) return a.kind.localeCompare(b.kind);
    return tb.localeCompare(ta);
  });

  // 5. CI: デフォルトブランチの最新 Actions run (best-effort)。
  let ci: RepoCi = EMPTY_CI;
  if (defaultBranch) {
    const runsRes = await get(
      `https://api.github.com/repos/${slug}/actions/runs?branch=${encodeURIComponent(defaultBranch)}&per_page=1`,
    );
    if (runsRes.ok) {
      const data = runsRes.data as GithubActionsRunsResponse;
      const run = data.workflow_runs?.[0];
      if (run) {
        ci = {
          status: run.status ?? null,
          conclusion: run.conclusion ?? null,
          url: run.html_url ?? null,
          workflow_name: run.name ?? null,
          run_at: run.updated_at ?? null,
        };
      }
    } else {
      errors.push(`ci: ${runsRes.error}`);
    }
  }

  return {
    default_branch: defaultBranch,
    open_pr_count: openPrCount,
    open_issue_count: openIssueCount,
    last_commit_sha: lastCommitSha,
    last_commit_message: lastCommitMessage,
    last_commit_url: lastCommitUrl,
    last_commit_at: lastCommitAt,
    items,
    ci,
    fetch_error: errors.length > 0 ? errors.join(' / ') : null,
  };
}

/**
 * GitHub REST v3 — デフォルトブランチの最新 N コミットだけ取る軽量版。
 * カード「開いた」 時の lazy fetch 用 (= ユーザがそのリポを見たいと表明
 * したタイミングだけ追加で API を叩く)。
 *   - GET /repos/{o}/{n}/commits?sha=&per_page=N
 * default_branch 未取得時は GitHub に決めさせる (sha 省略 = default を使う)。
 */
async function fetchGithubRecentCommits(
  owner: string,
  name: string,
  defaultBranch: string | null,
  token: string | null,
  limit: number,
): Promise<{ items: RepoCommit[]; error: string | null }> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Memoria-repo-watch',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const per = Math.min(50, Math.max(1, limit));
  const slug = `${owner}/${name}`;
  const url = defaultBranch
    ? `https://api.github.com/repos/${slug}/commits?sha=${encodeURIComponent(defaultBranch)}&per_page=${per}`
    : `https://api.github.com/repos/${slug}/commits?per_page=${per}`;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { items: [], error: `GitHub API ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = await res.json() as GithubCommitResponseFull[];
    const items: RepoCommit[] = data.map((c) => ({
      sha: c.sha ?? '',
      message: (c.commit?.message ?? '').split('\n')[0] || '',
      html_url: c.html_url ?? (c.sha ? `https://github.com/${slug}/commit/${c.sha}` : ''),
      author: c.author?.login ?? c.commit?.author?.name ?? null,
      when: c.commit?.committer?.date ?? c.commit?.author?.date ?? null,
    })).filter((c) => c.sha && c.html_url);
    return { items, error: null };
  } catch (e) {
    return { items: [], error: e instanceof Error ? e.message : String(e) };
  }
}

interface GithubCommitResponseFull {
  sha?: string;
  html_url?: string;
  author?: { login?: string } | null;       // GitHub user (login あり)、 anon commit では null
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
    committer?: { date?: string };
  };
}
