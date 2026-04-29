// Diary — aggregate a day of browser visit events (and optionally GitHub
// commits) and ask claude to write a daily report.
//
// Hourly buckets, top domains, and active hours are computed locally;
// claude is asked only to narrate.

import { spawn } from 'node:child_process';
import { visitEventsForDate } from './db.js';

const MIN_VISITS_FOR_REPORT = 1;

function extractDomain(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
}

/**
 * Aggregate the day from BOTH sources together (no URL-level dedup).
 * - visit_events: per-event log. 1 row = 1 hit at its precise hour.
 * - page_visits:  per-URL row touched today. 1 row = 1 hit at last_seen_at's hour.
 * Overlap between the two sources is intentional — when a URL appears in both,
 * that signals "heavy activity on that URL" (touched many times today, plus
 * still present in the per-URL touch table).
 */
export function aggregateDay(db, dateStr) {
  const hourlyVisits = new Array(24).fill(0);
  const domainTally = new Map();
  const domainHours = new Map(); // domain -> Set of hour buckets seen
  let firstSeen = null;
  let lastSeen = null;

  // 1) Per-event log
  const events = visitEventsForDate(db, dateStr);
  for (const e of events) {
    const localHour = new Date(e.visited_at.replace(' ', 'T')).getHours();
    const hour = Number.isFinite(localHour) ? localHour : 0;
    hourlyVisits[hour] += 1;
    if (!firstSeen || e.visited_at < firstSeen) firstSeen = e.visited_at;
    if (!lastSeen || e.visited_at > lastSeen) lastSeen = e.visited_at;
    if (e.domain) {
      domainTally.set(e.domain, (domainTally.get(e.domain) || 0) + 1);
      if (!domainHours.has(e.domain)) domainHours.set(e.domain, new Set());
      domainHours.get(e.domain).add(hour);
    }
  }

  // 2) Per-URL log (page_visits) — every URL touched on this date adds another hit.
  const visits = db.prepare(`
    SELECT v.url, v.last_seen_at
    FROM page_visits v
    WHERE date(v.last_seen_at, 'localtime') = ?
  `).all(dateStr);
  let pageVisitsContribution = 0;
  for (const v of visits) {
    const domain = extractDomain(v.url);
    if (!domain) continue;
    let hour = 0;
    try {
      hour = new Date(v.last_seen_at.replace(' ', 'T')).getHours();
      if (!Number.isFinite(hour)) hour = 0;
    } catch {}
    hourlyVisits[hour] += 1;
    pageVisitsContribution += 1;
    domainTally.set(domain, (domainTally.get(domain) || 0) + 1);
    if (!domainHours.has(domain)) domainHours.set(domain, new Set());
    domainHours.get(domain).add(hour);
    if (!firstSeen || v.last_seen_at < firstSeen) firstSeen = v.last_seen_at;
    if (!lastSeen || v.last_seen_at > lastSeen) lastSeen = v.last_seen_at;
  }

  const topDomains = [...domainTally.entries()]
    .map(([domain, count]) => ({
      domain,
      count,
      active_hours: [...(domainHours.get(domain) || [])].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const activeHours = hourlyVisits
    .map((n, h) => ({ hour: h, count: n }))
    .filter(b => b.count > 0)
    .map(b => b.hour);

  const totalEvents = hourlyVisits.reduce((s, n) => s + n, 0);

  const bookmarks = bookmarksForDate(db, dateStr);

  return {
    date: dateStr,
    total_events: totalEvents,
    unique_domains: domainTally.size,
    hourly_visits: hourlyVisits,
    top_domains: topDomains,
    active_hours: activeHours,
    first_event_at: firstSeen,
    last_event_at: lastSeen,
    bookmarks,
    sources: {
      visit_events: events.length,
      page_visits: pageVisitsContribution,
    },
  };
}

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

function formatCommit(c) {
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

function inferAuthHint({ probes, fmt }) {
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

/** Bookmarks created or accessed on `dateStr`. */
export function bookmarksForDate(db, dateStr) {
  const created = db.prepare(`
    SELECT id, url, title, summary, created_at
    FROM bookmarks
    WHERE date(created_at, 'localtime') = ?
    ORDER BY created_at ASC
  `).all(dateStr);

  const accessedRows = db.prepare(`
    SELECT b.id, b.url, b.title,
           MIN(a.accessed_at) AS first_accessed_at,
           MAX(a.accessed_at) AS last_accessed_at,
           COUNT(*) AS access_count
    FROM accesses a
    JOIN bookmarks b ON b.id = a.bookmark_id
    WHERE date(a.accessed_at, 'localtime') = ?
    GROUP BY b.id
    ORDER BY access_count DESC, last_accessed_at DESC
  `).all(dateStr);

  return { created, accessed: accessedRows };
}

const DIARY_PROMPT_TEMPLATE = ({ dateStr, metrics, github, notes }) => {
  const hourlyTable = metrics.hourly_visits
    .map((n, h) => `${String(h).padStart(2, '0')}:00 → ${n}`)
    .filter((_, h) => metrics.hourly_visits[h] > 0)
    .join(', ');
  const domainTable = metrics.top_domains
    .map(d => `${d.domain} (${d.count} 件 / 時間帯 ${d.active_hours.join(',')})`)
    .join('\n');
  const githubBlock = github?.commits?.length
    ? github.commits.map(c => `- [${c.repo} ${c.sha}] ${c.message}`).join('\n')
    : github?.error
      ? `(GitHub 取得失敗: ${github.error})`
      : '(GitHub commit なし)';
  const created = metrics.bookmarks?.created || [];
  const accessed = metrics.bookmarks?.accessed || [];
  const totalBookmarks = created.length + accessed.length;
  // When bookmark count balloons, the prompt becomes too long and the per-item
  // detail dilutes the narrative — fall back to a domain-only summary.
  const BOOKMARK_DETAIL_THRESHOLD = 10;
  let bookmarkSection;
  if (totalBookmarks === 0) {
    bookmarkSection = '新規・再訪したブックマーク: (なし)';
  } else if (totalBookmarks > BOOKMARK_DETAIL_THRESHOLD) {
    const allDomains = new Map();
    for (const b of [...created, ...accessed]) {
      try {
        const dom = new URL(b.url).hostname.toLowerCase();
        allDomains.set(dom, (allDomains.get(dom) || 0) + (b.access_count || 1));
      } catch {}
    }
    const domLines = [...allDomains.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([d, n]) => `- ${d} (${n} 件)`)
      .join('\n');
    bookmarkSection = [
      `ブックマーク総数: 新規 ${created.length} 件 + 再訪 ${accessed.length} 件 = ${totalBookmarks} 件`,
      '(個別タイトルは省略。ドメイン分布から作業内容を推察してください)',
      domLines,
    ].join('\n');
  } else {
    const createdBlock = created.length
      ? created.map(b => `- ${b.title} (${b.url})${b.summary ? '\n  ' + b.summary.slice(0, 200) : ''}`).join('\n')
      : '(新規ブックマークなし)';
    const accessedBlock = accessed.length
      ? accessed.map(b => `- ${b.title} ×${b.access_count} (${b.url})`).join('\n')
      : '(再訪したブックマークなし)';
    bookmarkSection = `新規ブックマーク:\n${createdBlock}\n\n再訪したブックマーク:\n${accessedBlock}`;
  }
  const notesBlock = notes ? `\nUSER NOTES (反映してください):\n${notes}\n` : '';
  return [
    `あなたは ${dateStr} の活動データから 1 日の日報を書きます。`,
    '事実だけを淡々と。憶測や創作はせず、データから読み取れる活動のみを書きます。',
    '',
    '出力フォーマット (markdown):',
    '## 全体像',
    '一段落で「何時頃から何時頃まで何をしていた風」かをまとめる。',
    '## 時間帯別',
    '- HH:00 〜 HH:00: ドメインから推測される作業',
    '## ブックマーク',
    '- 新規追加・再訪したブックマークから読み取れる関心',
    '## ハイライト',
    '- GitHub commit、印象的な調査、ニュース等',
    '',
    `日付: ${dateStr}`,
    `総アクセス: ${metrics.total_events}`,
    `ユニークドメイン: ${metrics.unique_domains}`,
    `アクティブ時間帯: ${hourlyTable || '(なし)'}`,
    '',
    'TOP DOMAINS:',
    domainTable || '(なし)',
    '',
    bookmarkSection,
    '',
    'GITHUB COMMITS:',
    githubBlock,
    notesBlock,
  ].join('\n');
};

export async function generateDiaryNarrative({ dateStr, metrics, github, notes, claudeBin = 'claude', timeoutMs = 180_000 }) {
  if (metrics.total_events < MIN_VISITS_FOR_REPORT && !github?.commits?.length && !notes) {
    return '本日の活動記録は取得できていません。';
  }
  const prompt = DIARY_PROMPT_TEMPLATE({ dateStr, metrics, github, notes });
  return await spawnClaude(claudeBin, prompt, timeoutMs);
}

function spawnClaude(bin, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`claude CLI timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`));
      else resolve(stdout.trim());
    });
    child.stdin.end(prompt, 'utf8');
  });
}

/** YYYY-MM-DD in local time for a given Date instance (or now). */
export function formatLocalDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Date string for "yesterday" relative to the supplied moment. */
export function yesterdayLocal(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return formatLocalDate(d);
}
