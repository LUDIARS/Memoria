// Diary — aggregate a day of browser visit events (and optionally GitHub
// commits) and ask claude to write a daily report.
//
// Hourly buckets, top domains, and active hours are computed locally;
// claude is asked only to narrate.

import { spawn } from 'node:child_process';
import { visitEventsForDate, getDiary, getDomainCatalogMap } from './db.js';

// Model selection. The `claude` CLI accepts `--model sonnet` and `--model opus`.
// We use Sonnet for the per-URL narrative (cheap, repetitive) and Opus 1M for
// the integrative highlight/weekly narrative.
const MODEL_SONNET = 'sonnet';
const MODEL_OPUS_1M = 'claude-opus-4-7[1m]';

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

  const topDomainList = [...domainTally.entries()]
    .map(([domain, count]) => ({
      domain,
      count,
      active_hours: [...(domainHours.get(domain) || [])].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  const catalog = getDomainCatalogMap(db, topDomainList.map(d => d.domain));
  const topDomains = topDomainList.map(d => {
    const cat = catalog.get(d.domain);
    return cat ? {
      ...d,
      description: cat.description || null,
      kind: cat.kind || null,
      catalog_title: cat.title || null,
    } : d;
  });

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

const WORK_CONTENT_PROMPT = ({ dateStr, urlList, totalEvents, totalDomains }) => [
  `あなたは ${dateStr} の「作業内容」セクションを書きます。`,
  'ブラウザ閲覧履歴 (URL + 時刻) からドメインとパス構造を読み解き、その時間帯に何の作業をしていたかを推察して時系列で書いてください。',
  '',
  '出力ルール:',
  '- markdown 一段落 + 時間帯ごとの箇条書き',
  '- 各時間帯は HH:MM-HH:MM の範囲で、1〜3 行で「何をしていた風」を記述',
  '- 推測でも断定口調 (◯◯を確認)。「〜していたと推測」は不要',
  '- ドメインの羅列は禁止。意味のある作業として書く',
  '- URL を直接引用せず、内容を要約',
  '',
  `日付: ${dateStr}`,
  `総アクセス: ${totalEvents}`,
  `ユニークドメイン: ${totalDomains}`,
  '',
  'URL 履歴 (時刻 + URL):',
  urlList,
].join('\n');

const HIGHLIGHTS_PROMPT = ({ dateStr, workContent, githubByRepo, bookmarkSummary, notes, metrics }) => [
  `あなたは ${dateStr} の「ハイライト」セクションを書きます。`,
  '以下の 3 種類の情報を統合し、その日の重要なポイントを箇条書きで 3〜6 個。',
  '事実ベース。憶測や創作はしない。重要度の高い順。',
  '',
  '## 入力 1: 作業内容 (時系列)',
  workContent || '(なし)',
  '',
  '## 入力 2: 新規ブックマーク件数',
  `${bookmarkSummary.created} 件 (再訪 ${bookmarkSummary.accessed} 件)`,
  bookmarkSummary.topDomains
    ? `主なドメイン: ${bookmarkSummary.topDomains.join(', ')}`
    : '',
  '',
  '## 入力 3: GitHub commits (リポジトリごとの件数)',
  githubByRepo.repos.length
    ? githubByRepo.repos.map(r => `- ${r.repo}: ${r.count} commits`).join('\n')
    : '(なし)',
  '',
  '## メタ情報',
  `総アクセス: ${metrics.total_events} / アクティブ時間帯: ${metrics.active_hours.join(',')}`,
  '',
  notes ? `## ユーザのメモ・補足 (反映してください)\n${notes}\n` : '',
  '',
  '出力フォーマット (markdown のみ。前置き不要):',
  '- ハイライト1',
  '- ハイライト2',
].join('\n');

// Legacy single-prompt template — retained for fallback if a stage fails so we
// can still return some narrative.
const DIARY_PROMPT_TEMPLATE = ({ dateStr, metrics, github, notes }) => {
  const hourlyTable = metrics.hourly_visits
    .map((n, h) => `${String(h).padStart(2, '0')}:00 → ${n}`)
    .filter((_, h) => metrics.hourly_visits[h] > 0)
    .join(', ');
  const domainTable = metrics.top_domains
    .map(d => {
      const desc = d.description ? ` — ${d.description}` : '';
      return `${d.domain} (${d.count} 件 / 時間帯 ${d.active_hours.join(',')})${desc}`;
    })
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

/**
 * Build the URL list for the work-content prompt. Format: "HH:MM <url>" per line,
 * deduped consecutively (collapse runs of the same URL within 2 minutes).
 */
function buildUrlList(db, dateStr) {
  const events = visitEventsForDate(db, dateStr);
  if (events.length === 0) {
    // Fall back to page_visits where last_seen is the date.
    const visits = db.prepare(`
      SELECT v.url, v.last_seen_at FROM page_visits v
      WHERE date(v.last_seen_at, 'localtime') = ?
      ORDER BY v.last_seen_at ASC
    `).all(dateStr);
    return visits.map(v => formatUrlLine(v.last_seen_at, v.url)).join('\n');
  }
  const lines = [];
  let lastUrl = '';
  let lastTs = 0;
  for (const e of events) {
    const ts = new Date(e.visited_at.replace(' ', 'T')).getTime();
    if (e.url === lastUrl && Math.abs(ts - lastTs) < 120_000) continue; // collapse <2min
    lines.push(formatUrlLine(e.visited_at, e.url));
    lastUrl = e.url;
    lastTs = ts;
  }
  // Cap to a sane upper bound to avoid stalling Sonnet.
  return lines.slice(-800).join('\n');
}

function formatUrlLine(ts, url) {
  // ts may be 'YYYY-MM-DD HH:MM:SS' (sqlite) — pull HH:MM
  const m = String(ts).match(/(\d{2}:\d{2})/);
  return `${m ? m[1] : '??:??'} ${url}`;
}

/** Stage 1: Sonnet writes 作業内容 from the URL timeline. */
export async function generateWorkContent({ db, dateStr, metrics, claudeBin = 'claude', timeoutMs = 180_000 }) {
  const urlList = buildUrlList(db, dateStr);
  if (!urlList.trim()) return '';
  const prompt = WORK_CONTENT_PROMPT({
    dateStr,
    urlList,
    totalEvents: metrics.total_events,
    totalDomains: metrics.unique_domains,
  });
  return await spawnClaude(claudeBin, prompt, MODEL_SONNET, timeoutMs);
}

/** Stage 3: Opus 1M integrates work content + bookmark count + commits into highlights. */
export async function generateHighlights({ dateStr, workContent, githubByRepo, bookmarkSummary, notes, metrics, claudeBin = 'claude', timeoutMs = 240_000 }) {
  const prompt = HIGHLIGHTS_PROMPT({
    dateStr, workContent, githubByRepo, bookmarkSummary, notes, metrics,
  });
  return await spawnClaude(claudeBin, prompt, MODEL_OPUS_1M, timeoutMs);
}

/**
 * Top-level diary generator orchestrating the three stages. Returns the
 * structured pieces; the caller persists them.
 */
export async function generateDiary({ db, dateStr, metrics, github, notes, claudeBin = 'claude' }) {
  const githubByRepo = summarizeGithubByRepo(github);
  const bookmarkSummary = buildBookmarkSummary(metrics);

  // Edge case: nothing happened at all.
  if (metrics.total_events < MIN_VISITS_FOR_REPORT
      && !github?.commits?.length && !notes
      && bookmarkSummary.created === 0 && bookmarkSummary.accessed === 0) {
    return {
      workContent: '',
      githubByRepo,
      highlights: '',
      summary: '本日の活動記録は取得できていません。',
    };
  }

  const workContent = await generateWorkContent({ db, dateStr, metrics, claudeBin });
  const highlights = await generateHighlights({
    dateStr, workContent, githubByRepo, bookmarkSummary, notes, metrics, claudeBin,
  });

  // Combined summary for legacy display.
  const summary = composeSummary({ workContent, githubByRepo, highlights });
  return { workContent, githubByRepo, highlights, summary };
}

function buildBookmarkSummary(metrics) {
  const created = metrics.bookmarks?.created || [];
  const accessed = metrics.bookmarks?.accessed || [];
  const domSet = new Set();
  for (const b of [...created, ...accessed]) {
    try { domSet.add(new URL(b.url).hostname); } catch {}
  }
  return {
    created: created.length,
    accessed: accessed.length,
    topDomains: [...domSet].slice(0, 8),
  };
}

function composeSummary({ workContent, githubByRepo, highlights }) {
  const parts = [];
  if (workContent) parts.push(`## 作業内容\n${workContent.trim()}`);
  if (githubByRepo.repos.length) {
    const repoLines = githubByRepo.repos
      .map(r => `- ${r.repo}: ${r.count} commits`)
      .join('\n');
    parts.push(`## GitHub commits (${githubByRepo.total} 件)\n${repoLines}`);
  }
  if (highlights) parts.push(`## ハイライト\n${highlights.trim()}`);
  return parts.join('\n\n');
}

function spawnClaude(bin, prompt, model, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ['-p'];
    if (model) args.push('--model', model);
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`claude CLI (${model || 'default'}) timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude (${model || 'default'}) exited ${code}: ${stderr.slice(0, 400)}`));
      else resolve(stdout.trim());
    });
    child.stdin.end(prompt, 'utf8');
  });
}

// ── weekly --------------------------------------------------------------

const WEEKLY_PROMPT = ({ weekStart, weekEnd, dailyBlock, githubBlock }) => [
  `あなたは ${weekStart} から ${weekEnd} までの「週報」を書きます。`,
  '7 日分の日報と GitHub コミットヒストリから、週全体での実作業を統合してください。',
  '',
  '出力フォーマット (markdown のみ。前置き不要):',
  '## 今週やったこと',
  '一段落で週全体を概観。',
  '## 主な成果',
  '- 箇条書き。GitHub commit から実装した機能・修正を中心に。',
  '- 進捗が大きかったプロジェクトを優先。',
  '## トピック別',
  '- 学んだこと・調べたこと (作業内容ベース)',
  '## 来週への引き継ぎ',
  '- 未完了に見える作業やフォローアップ',
  '',
  '出力ルール:',
  '- 創作禁止。日報と commit に基づくこと',
  '- リポジトリ名は短く (org/ は省いて末尾のみで OK)',
  '',
  '## 入力 1: 日報サマリ (日付ごと)',
  dailyBlock,
  '',
  '## 入力 2: GitHub commit ヒストリ',
  githubBlock,
].join('\n');

/**
 * Generate a weekly narrative from 7 daily diaries + commits.
 * The caller pre-fetches both via the GitHub API (per-repo commits API).
 */
export async function generateWeekly({ weekStart, weekEnd, dailyDiaries, githubByRepo, claudeBin = 'claude', timeoutMs = 360_000 }) {
  const dailyBlock = dailyDiaries.map(d => {
    const head = d.summary || d.work_content || '(日報なし)';
    return `### ${d.date}\n${(head || '').slice(0, 1500)}`;
  }).join('\n\n');
  const githubBlock = githubByRepo.repos.length
    ? githubByRepo.repos.map(r => {
      const samples = (r.samples || []).map(s => `  - ${s.sha} ${s.message}`).join('\n');
      return `${r.repo}: ${r.count} commits\n${samples}`;
    }).join('\n\n')
    : '(commit なし)';
  const prompt = WEEKLY_PROMPT({ weekStart, weekEnd, dailyBlock, githubBlock });
  return await spawnClaude(claudeBin, prompt, MODEL_OPUS_1M, timeoutMs);
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

/** Monday → Sunday inclusive range that contains `dateStr`. */
export function weekRangeFor(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  // Mon=1,...,Sun=7 (ISO). JS getDay: Sun=0,Mon=1,...
  const dow = d.getDay();
  const offsetToMonday = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(d);
  mon.setDate(d.getDate() + offsetToMonday);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { start: formatLocalDate(mon), end: formatLocalDate(sun) };
}

/** Which week-of-month does `weekStart` fall in (1-based, by Mon). */
export function weekOfMonth(weekStart) {
  const d = new Date(weekStart + 'T00:00:00');
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  // Find first Monday in the month containing weekStart's Monday.
  const firstDay = new Date(d.getFullYear(), d.getMonth(), 1);
  const dow = firstDay.getDay();
  const firstMon = new Date(firstDay);
  firstMon.setDate(1 + ((dow === 0 ? 1 : (8 - dow) % 7)));
  const diffDays = Math.round((d - firstMon) / 86400000);
  const idx = Math.floor(diffDays / 7) + 1;
  return { month, weekInMonth: idx };
}
