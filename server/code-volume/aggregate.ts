import { isCodeFile } from './file-filter.js';
import { daysInMonth, JST_OFFSET_MINUTES, monthOf } from './period.js';
import type { AuthorIdentity, CommitVolume, MonthVolume, VolumeReport } from './types.js';

const TOP_REPOS = 5;

/** コードファイルに限った追加・削除行。 */
export function codeLines(c: CommitVolume): { additions: number; deletions: number } {
  let additions = 0, deletions = 0;
  for (const f of c.files) {
    if (!isCodeFile(f.path)) continue;
    additions += f.additions;
    deletions += f.deletions;
  }
  return { additions, deletions };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 指定月に入るコミットを集計する。 sha が重なっていても 1 回だけ数える。 */
export function summarizeMonth(
  month: string,
  commits: CommitVolume[],
  offsetMinutes = JST_OFFSET_MINUTES,
): MonthVolume {
  const seen = new Set<string>();
  const inMonth = commits.filter((c) => {
    if (seen.has(c.sha) || monthOf(c.authoredAt, offsetMinutes) !== month) return false;
    seen.add(c.sha);
    return true;
  });
  const byRepo = new Map<string, { changed: number; codeChanged: number }>();
  let additions = 0, deletions = 0, codeAdditions = 0, codeDeletions = 0, truncated = 0;
  for (const c of inMonth) {
    additions += c.additions;
    deletions += c.deletions;
    const code = codeLines(c);
    codeAdditions += code.additions;
    codeDeletions += code.deletions;
    if (c.filesTruncated) truncated += 1;
    const r = byRepo.get(c.repo) ?? { changed: 0, codeChanged: 0 };
    r.changed += c.additions + c.deletions;
    r.codeChanged += code.additions + code.deletions;
    byRepo.set(c.repo, r);
  }
  const days = daysInMonth(month);
  const changed = additions + deletions;
  const codeChanged = codeAdditions + codeDeletions;
  return {
    month,
    days,
    commits: inMonth.length,
    repos: byRepo.size,
    additions,
    deletions,
    changed,
    codeAdditions,
    codeDeletions,
    codeChanged,
    weeklyAvgChanged: round1(changed / (days / 7)),
    weeklyAvgCodeChanged: round1(codeChanged / (days / 7)),
    topRepos: [...byRepo.entries()]
      .map(([repo, v]) => ({ repo, ...v }))
      .sort((a, b) => b.codeChanged - a.codeChanged || b.changed - a.changed)
      .slice(0, TOP_REPOS),
    truncatedCommits: truncated,
  };
}

export function buildReport(input: {
  months: string[];
  commits: CommitVolume[];
  authors: AuthorIdentity[];
  generatedAt: string;
  offsetMinutes?: number;
  timeZone?: string;
}): VolumeReport {
  const offset = input.offsetMinutes ?? JST_OFFSET_MINUTES;
  const months = [...new Set(input.months)].sort().map((m) => summarizeMonth(m, input.commits, offset));
  const n = months.length || 1;
  const totalDays = months.reduce((s, m) => s + m.days, 0) || 7;
  const sumChanged = months.reduce((s, m) => s + m.changed, 0);
  const sumCode = months.reduce((s, m) => s + m.codeChanged, 0);
  return {
    generatedAt: input.generatedAt,
    authors: input.authors,
    timeZone: input.timeZone ?? 'Asia/Tokyo',
    months,
    monthlyAvgChanged: round1(sumChanged / n),
    monthlyAvgCodeChanged: round1(sumCode / n),
    weeklyAvgChanged: round1(sumChanged / (totalDays / 7)),
    weeklyAvgCodeChanged: round1(sumCode / (totalDays / 7)),
  };
}
