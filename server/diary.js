// Diary — aggregate a day of browser visit events (and optionally GitHub
// commits) and ask claude to write a daily report.
//
// Hourly buckets, top domains, and active hours are computed locally;
// claude is asked only to narrate.

import { spawn } from 'node:child_process';
import { visitEventsForDate } from './db.js';

const MIN_VISITS_FOR_REPORT = 1;

/** Aggregate raw visit events for a date into chartable + claude-friendly metrics. */
export function aggregateDay(db, dateStr) {
  const events = visitEventsForDate(db, dateStr);
  const hourlyVisits = new Array(24).fill(0);
  const domainTally = new Map();
  const domainHours = new Map(); // domain -> Set of hour buckets seen
  let firstSeen = null;
  let lastSeen = null;

  for (const e of events) {
    const dt = new Date(e.visited_at.replace(' ', 'T') + (e.visited_at.endsWith('Z') ? '' : 'Z'));
    if (!Number.isFinite(dt.getTime())) continue;
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

  return {
    date: dateStr,
    total_events: events.length,
    unique_domains: domainTally.size,
    hourly_visits: hourlyVisits,
    top_domains: topDomains,
    active_hours: activeHours,
    first_event_at: firstSeen,
    last_event_at: lastSeen,
  };
}

/** Fetch a user's PushEvents on a given date from the GitHub Events API. */
export async function fetchGithubActivity({ token, user, repos, dateStr, timeoutMs = 30_000 }) {
  if (!user) return null;

  // GitHub Events API only returns the last ~90 days of events anyway.
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Memoria-diary/0.1',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const url = `https://api.github.com/users/${encodeURIComponent(user)}/events?per_page=100`;
    const res = await fetch(url, { headers, signal: ac.signal });
    if (!res.ok) {
      return { error: `github API ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    const events = await res.json();
    const repoFilter = (repos && repos.length > 0)
      ? new Set(repos.map(r => r.toLowerCase()))
      : null;
    const commits = [];
    for (const ev of events) {
      if (ev.type !== 'PushEvent') continue;
      const evDate = (ev.created_at || '').slice(0, 10);
      if (evDate !== dateStr) continue;
      const repoName = ev.repo?.name?.toLowerCase();
      if (repoFilter && !repoFilter.has(repoName)) continue;
      const evCommits = ev.payload?.commits || [];
      for (const c of evCommits) {
        commits.push({
          repo: ev.repo?.name,
          sha: (c.sha || '').slice(0, 7),
          message: (c.message || '').split('\n')[0].slice(0, 200),
          author: c.author?.name || '',
          created_at: ev.created_at,
        });
      }
    }
    return { commits, fetched_at: new Date().toISOString() };
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

const DIARY_PROMPT_TEMPLATE = ({ dateStr, metrics, github, notes }) => {
  const hourlyTable = metrics.hourly_visits
    .map((n, h) => `${String(h).padStart(2, '0')}:00 → ${n}`)
    .filter((_, h) => metrics.hourly_visits[h] > 0)
    .join(', ');
  const domainTable = metrics.top_domains
    .map(d => `${d.domain} (${d.count} 件 / ${d.active_hours.length} 時間帯)`)
    .join('\n');
  const githubBlock = github?.commits?.length
    ? github.commits.map(c => `- [${c.repo} ${c.sha}] ${c.message}`).join('\n')
    : '(GitHub commit なし)';
  const notesBlock = notes ? `\nUSER NOTES:\n${notes}\n` : '';
  return [
    `あなたは ${dateStr} の活動データから 1 日の日報を書きます。`,
    '事実だけを淡々と。憶測や創作はせず、データから読み取れる活動のみを書きます。',
    '',
    '出力フォーマット (markdown):',
    '## 全体像',
    '一段落で「何時頃から何時頃まで何をしていた風」かをまとめる。',
    '## 時間帯別',
    '- HH:00 〜 HH:00: ドメインから推測される作業',
    '## ハイライト',
    '- 印象的なドメインや、commit があれば反映する',
    '',
    `日付: ${dateStr}`,
    `総アクセス: ${metrics.total_events}`,
    `ユニークドメイン: ${metrics.unique_domains}`,
    `アクティブ時間帯: ${hourlyTable || '(なし)'}`,
    '',
    'TOP DOMAINS:',
    domainTable || '(なし)',
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
    const child = spawn(bin, ['-p', prompt], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
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
