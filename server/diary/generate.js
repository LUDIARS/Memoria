// LLM-driven daily / weekly narrative generators. Stages 1 (work content) and
// 3 (highlights) are run from `generateDiary`; the weekly summary is produced
// independently by `generateWeekly`.

import { runLlm } from '../llm.js';
import {
  WORK_CONTENT_PROMPT,
  HIGHLIGHTS_PROMPT,
  WEEKLY_PROMPT,
  appendMemoAndImprove,
  buildBookmarkSummary,
  buildUrlList,
  composeSummary,
  extractWorkMinutes,
} from './prompt.js';
import { summarizeGithubByRepo } from './github.js';

// Default models per task are configured in llm.js (sonnet for diary_work,
// opus 1M for diary_highlights / diary_weekly). The user can override per task
// from the AI settings panel.

const MIN_VISITS_FOR_REPORT = 1;

/**
 * Stage 1: Sonnet (default) writes 作業内容 from the URL timeline AND infers
 * the day's focused work minutes (tail line `WORK_MINUTES: <int>`). Returns
 * `{ content, workMinutes }` — content is the markdown shown to the user
 * (tail stripped), workMinutes feeds the trends chart.
 */
export async function generateWorkContent({ db, dateStr, metrics, globalMemo, improve, timeoutMs = 180_000 }) {
  const urlList = buildUrlList(db, dateStr);
  if (!urlList.trim()) return { content: '', workMinutes: null };
  const base = WORK_CONTENT_PROMPT({
    dateStr,
    urlList,
    totalEvents: metrics.total_events,
    totalDomains: metrics.unique_domains,
  });
  const prompt = appendMemoAndImprove(base, { globalMemo, improve });
  const raw = await runLlm({ task: 'diary_work', prompt, timeoutMs });
  return extractWorkMinutes(raw);
}

/** Stage 3: Opus 1M (default) integrates work content + bookmark count + commits + dig into highlights. */
export async function generateHighlights({ dateStr, workContent, githubByRepo, bookmarkSummary, digs, notes, metrics, globalMemo, improve, timeoutMs = 240_000 }) {
  const base = HIGHLIGHTS_PROMPT({
    dateStr, workContent, githubByRepo, bookmarkSummary, digs, notes, metrics,
  });
  const prompt = appendMemoAndImprove(base, { globalMemo, improve });
  return await runLlm({ task: 'diary_highlights', prompt, timeoutMs });
}

/**
 * Top-level diary generator orchestrating the three stages. Returns the
 * structured pieces; the caller persists them.
 */
export async function generateDiary({ db, dateStr, metrics, github, notes }) {
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

  const { content: workContent, workMinutes } = await generateWorkContent({ db, dateStr, metrics });
  const digs = metrics.digs || [];
  const highlights = await generateHighlights({
    dateStr, workContent, githubByRepo, bookmarkSummary, digs, notes, metrics,
  });

  // Combined summary for legacy display.
  const summary = composeSummary({ workContent, githubByRepo, highlights, digs });
  return { workContent, workMinutes, githubByRepo, highlights, summary, digs };
}

/**
 * Generate a weekly narrative from 7 daily diaries + commits.
 * The caller pre-fetches both via the GitHub API (per-repo commits API).
 */
export async function generateWeekly({ weekStart, weekEnd, dailyDiaries, githubByRepo, timeoutMs = 360_000 }) {
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
  return await runLlm({ task: 'diary_weekly', prompt, timeoutMs });
}
