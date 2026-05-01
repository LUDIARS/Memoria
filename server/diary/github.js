// GitHub commit fetching + summarization helpers.

/**
 * Fetch a user's commits authored on `dateStr`.
 * - If `repos` is supplied: per-repo commits API (works for public repos
 *   without auth; needs PAT for private).
 * - Otherwise: GitHub search/commits across all of GitHub (PAT required).
 *
 * The events API was avoided because /users/{user}/events does not include
 * commit lists in its payload (only ref/head/before SHAs).
 */
export async function fetchGithubActivity({ token, user, repos, dateStr, timeoutMs = 30_000 }) {
  if (!user) return null;

  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Memoria-diary/0.1',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const since = `${dateStr}T00:00:00Z`;
  const until = `${dateStr}T23:59:59Z`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const commits = [];
  const errors = [];

  try {
    if (repos && repos.length > 0) {
      for (const repo of repos) {
        const url = `https://api.github.com/repos/${repo}/commits`
          + `?author=${encodeURIComponent(user)}`
          + `&since=${encodeURIComponent(since)}`
          + `&until=${encodeURIComponent(until)}`
          + `&per_page=100`;
        const res = await fetch(url, { headers, signal: ac.signal });
        if (!res.ok) {
          errors.push(`${repo}: ${res.status} ${res.statusText}`);
          continue;
        }
        const arr = await res.json();
        for (const c of arr) {
          commits.push(formatCommit({ ...c, _repo: repo }));
        }
      }
    } else {
      // Search across all repos the user can reach. Needs auth.
      const q = `author:${user} author-date:${dateStr}`;
      const url = `https://api.github.com/search/commits?q=${encodeURIComponent(q)}&per_page=100`;
      const res = await fetch(url, { headers, signal: ac.signal });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        return { error: `github API ${res.status}: ${body}` };
      }
      const data = await res.json();
      for (const c of (data.items || [])) {
        commits.push(formatCommit({ ...c, _repo: c.repository?.full_name }));
      }
    }
    return {
      commits,
      errors: errors.length ? errors : undefined,
      fetched_at: new Date().toISOString(),
    };
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

export function formatCommit(c) {
  const fullMsg = c.commit?.message || '';
  return {
    repo: c._repo || c.repository?.full_name || '',
    sha: (c.sha || '').slice(0, 7),
    message: fullMsg.split('\n')[0].slice(0, 200),
    author: c.commit?.author?.name || c.author?.login || '',
    created_at: c.commit?.author?.date || c.commit?.committer?.date || '',
    url: c.html_url || '',
  };
}

/**
 * Probe a few GitHub endpoints to figure out *why* a PAT is failing — a single
 * /user call can return 401 simply because a fine-grained PAT lacks Account
 * permissions, even though the token itself is valid.
 */
export async function pingGithub({ token, user, timeoutMs = 12_000 }) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Memoria-diary/0.1',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  const fmt = {
    classic: !!(token && /^gh[pousr]_/.test(token)),
    fine_grained: !!(token && /^github_pat_/.test(token)),
    length: token ? token.length : 0,
  };

  const probes = [];
  async function tryProbe(name, url) {
    try {
      const res = await fetch(url, { headers, signal: ac.signal });
      let body = '';
      if (!res.ok) body = (await res.text()).slice(0, 200);
      probes.push({ name, url, status: res.status, ok: res.ok, body });
      return res;
    } catch (e) {
      probes.push({ name, url, error: e.message });
      return null;
    }
  }

  try {
    const userRes = await tryProbe('user', 'https://api.github.com/user');
    await tryProbe('rate_limit', 'https://api.github.com/rate_limit');
    if (user) {
      await tryProbe('user_public', `https://api.github.com/users/${encodeURIComponent(user)}`);
    }

    if (userRes?.ok) {
      const data = await userRes.json();
      return {
        ok: true,
        login: data.login,
        scopes: userRes.headers.get('x-oauth-scopes') || '',
        token_format: fmt,
        probes,
      };
    }

    // Build a diagnostic hint based on what failed.
    const hint = inferAuthHint({ probes, fmt });
    return { ok: false, status: userRes?.status, hint, token_format: fmt, probes };
  } catch (e) {
    return { ok: false, error: e.message, token_format: fmt, probes };
  } finally {
    clearTimeout(timer);
  }
}

export function inferAuthHint({ probes, fmt }) {
  const userProbe = probes.find(p => p.name === 'user');
  const rate = probes.find(p => p.name === 'rate_limit');
  const userPub = probes.find(p => p.name === 'user_public');

  // /users/<u> works WITHOUT auth normally, so a 401 there means the Bearer
  // header itself was rejected — i.e. the token is unknown to GitHub.
  if (userPub?.status === 401) {
    return 'トークン自体が GitHub に存在しません (revoke 済み・期限切れ・別アカウント発行・コピー切れのいずれか)。GitHub Settings → Developer settings → Personal access tokens を開き、保存されているトークン (先頭は github_pat_) が一覧にあり active か確認してください。なければ作り直しが必要です。';
  }
  if (rate?.ok && userProbe?.status === 401 && fmt.fine_grained) {
    return 'トークンは生きていますが /user で拒否。fine-grained PAT は発行時に Account permissions → "Profile (Read)" を有効化しないと /user 系が通りません。';
  }
  if (userProbe?.status === 401 && fmt.classic) {
    return 'classic PAT が拒否されました。期限切れ・revoke・スコープ不足の可能性。`repo` と `read:user` を含めて作り直してください。';
  }
  if (userProbe?.status === 401 && !fmt.classic && !fmt.fine_grained) {
    return 'PAT のフォーマットが GitHub の標準形式 (`ghp_...` か `github_pat_...`) と一致しません。トークンを再確認してください。';
  }
  return 'GitHub から 401 が返りました。期限切れ・revoke・権限不足のいずれかです。';
}

/** GitHub commits grouped by repository: { byRepo: {repo: count}, total, repos: [...] }. */
export function summarizeGithubByRepo(github) {
  const commits = github?.commits || [];
  const byRepo = new Map();
  for (const c of commits) {
    const r = c.repo || '(unknown)';
    if (!byRepo.has(r)) byRepo.set(r, { count: 0, samples: [] });
    const cur = byRepo.get(r);
    cur.count += 1;
    if (cur.samples.length < 3) cur.samples.push({ sha: c.sha, message: c.message });
  }
  const repos = [...byRepo.entries()]
    .map(([repo, v]) => ({ repo, count: v.count, samples: v.samples }))
    .sort((a, b) => b.count - a.count);
  return { repos, total: commits.length };
}

/** Fetch a user's commits across `repos` in a date range, grouped by repo. */
export async function fetchGithubRange({ token, user, repos, since, until, timeoutMs = 30_000 }) {
  if (!user || !repos?.length) return { commits: [], repos: [] };
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Memoria-diary/0.1',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const all = [];
  try {
    for (const repo of repos) {
      const url = `https://api.github.com/repos/${repo}/commits`
        + `?author=${encodeURIComponent(user)}`
        + `&since=${encodeURIComponent(since)}`
        + `&until=${encodeURIComponent(until)}`
        + `&per_page=100`;
      const res = await fetch(url, { headers, signal: ac.signal });
      if (!res.ok) continue;
      const arr = await res.json();
      for (const c of arr) all.push(formatCommit({ ...c, _repo: repo }));
    }
    return { commits: all, ...summarizeGithubByRepo({ commits: all }) };
  } finally {
    clearTimeout(timer);
  }
}
