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

export interface RepoStats {
  default_branch: string | null;
  open_pr_count: number | null;
  open_issue_count: number | null;
  last_commit_sha: string | null;
  last_commit_message: string | null;
  last_commit_url: string | null;
  last_commit_at: string | null;
  /** 取得に失敗した場合の理由 (= 部分的にしか取れなかった時も入れる)。 成功なら null。 */
  fetch_error: string | null;
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

const EMPTY_STATS: RepoStats = {
  default_branch: null,
  open_pr_count: null,
  open_issue_count: null,
  last_commit_sha: null,
  last_commit_message: null,
  last_commit_url: null,
  last_commit_at: null,
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
interface GithubSearchResponse {
  total_count?: number;
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

  // 3. open PR 件数 (best-effort, search API)。 Issue 件数はそこから逆算。
  let openPrCount: number | null = null;
  let openIssueCount: number | null = null;
  const searchRes = await get(
    `https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${slug} is:pr is:open`)}&per_page=1`,
  );
  if (searchRes.ok) {
    const s = searchRes.data as GithubSearchResponse;
    openPrCount = typeof s.total_count === 'number' ? s.total_count : null;
    if (openPrCount != null && openIssuesAndPrs != null) {
      openIssueCount = Math.max(0, openIssuesAndPrs - openPrCount);
    }
  } else {
    errors.push(`PR count: ${searchRes.error}`);
    // search が落ちても open_issues_count (issue+PR 合算) は出しておく。
    openIssueCount = openIssuesAndPrs;
  }

  return {
    default_branch: defaultBranch,
    open_pr_count: openPrCount,
    open_issue_count: openIssueCount,
    last_commit_sha: lastCommitSha,
    last_commit_message: lastCommitMessage,
    last_commit_url: lastCommitUrl,
    last_commit_at: lastCommitAt,
    fetch_error: errors.length > 0 ? errors.join(' / ') : null,
  };
}
