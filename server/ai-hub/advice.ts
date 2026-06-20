// ai-hub — AIアドバイス。 直近 1 週間の 日記 / ニュース / 傾向(commits) / おすすめ /
// タスク を集め、 ai_advice LLM で助言 (Markdown) を生成して保存する。
//
// domain 間 cross-import 禁止規約のため、 各 domain の DB アクセスは db.ts の
// 公開関数 (listDiariesInRange / recGitCommits / getLatestRecommendationRun /
// listTasks) と rss バレルの公開関数 (getLatestDigest) のみを使う。 収集ロジック
// はこの advice.ts に閉じる。
// Spec: spec/feature/ai-hub.md §advice.ts

import type BetterSqlite3 from 'better-sqlite3';
import {
  listDiariesInRange, recGitCommits, getLatestRecommendationRun, listTasks,
  insertAiAdvice, latestAiAdvice,
} from '../db.js';
import { getLatestDigest } from '../rss/index.js';
import { runLlm } from '../llm.js';
import { formatLocalDate } from '../diary.js';
import type { AiAdvice } from './types.js';

type Db = BetterSqlite3.Database;

const WINDOW_DAYS = 7;

function dateNDaysAgo(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - n);
  return formatLocalDate(d);
}

interface CollectedWeek {
  prompt: string;
  summary: Record<string, number>;
}

/** 週次データを集めて LLM プロンプトと件数サマリを作る。 */
function collectWeek(db: Db, dateStr: string): CollectedWeek {
  const start = dateNDaysAgo(dateStr, WINDOW_DAYS - 1);
  const end = dateStr;

  const diaries = listDiariesInRange(db, { start, end });
  const commits = recGitCommits(db, WINDOW_DAYS, 80);
  const rec = getLatestRecommendationRun(db, 'done');
  const tasks = [
    ...listTasks(db, { status: 'todo', limit: 30 }),
    ...listTasks(db, { status: 'doing', limit: 30 }),
  ];
  const rssDigest = getLatestDigest(db);

  // ── プロンプト材料の整形 ────────────────────────────────────────────────
  const diaryBlock = diaries.length
    ? diaries.map((d) => `### ${d.date} (${d.status})\n${(d.summary || d.work_content || '').slice(0, 600)}`).join('\n\n')
    : '(日記なし)';

  const commitBlock = commits.length
    ? commits.slice(0, 50).map((c) => `- ${c.occurred_at.slice(0, 10)} ${c.source ?? ''}: ${(c.content || '').slice(0, 120)}`).join('\n')
    : '(commit なし)';

  let recBlock = '(おすすめ実行なし)';
  if (rec && rec.results_json) {
    recBlock = String(rec.results_json).slice(0, 2_000);
  }

  const taskBlock = tasks.length
    ? tasks.slice(0, 30).map((t) => `- [${t.status}] ${t.title.slice(0, 100)}`).join('\n')
    : '(タスクなし)';

  const rssBlock = rssDigest && rssDigest.content
    ? rssDigest.content.slice(0, 2_000)
    : '(ニュースダイジェストなし)';

  const prompt = [
    'あなたはユーザの 1 週間の生活・作業データを俯瞰して、 次の一手を助言するコーチだ。',
    '以下のデータをもとに、 実行可能で具体的な助言を Markdown で書け。 過度な精神論は避け、',
    'データに根拠を置く。 良かった点 / 詰まっている点 / 次にやるべきこと を中心に。',
    '',
    `## 期間: ${start} 〜 ${end}`,
    '',
    '## 日記',
    diaryBlock,
    '',
    '## git commit (傾向)',
    commitBlock,
    '',
    '## 最新のおすすめ (recommendation)',
    recBlock,
    '',
    '## ニュースダイジェスト',
    rssBlock,
    '',
    '## 未完了タスク',
    taskBlock,
    '',
    '## 出力',
    'Markdown の助言本文だけを返せ (前後の説明・コードフェンス不要)。',
  ].join('\n');

  const summary: Record<string, number> = {
    diaries: diaries.length,
    commits: commits.length,
    tasks: tasks.length,
    has_recommendation: rec ? 1 : 0,
    has_rss_digest: rssDigest ? 1 : 0,
  };

  return { prompt, summary };
}

/** AIアドバイスを生成して ai_advice に保存する。 戻り値は保存した最新行。 */
export async function runAdvice(db: Db, dateStr: string): Promise<AiAdvice | null> {
  const { prompt, summary } = collectWeek(db, dateStr);
  const body = (await runLlm({ task: 'ai_advice', prompt })).trim();
  insertAiAdvice(db, {
    for_date: dateStr,
    body_md: body || '(助言の生成に失敗しました)',
    data_summary: summary,
  });
  console.log(`[ai-hub advice] ${dateStr}: ${JSON.stringify(summary)}`);
  return latestAiAdvice(db);
}
