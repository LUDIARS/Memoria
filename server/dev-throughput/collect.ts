// 日次集計の収集 use case。
// - マージ件数: Revisor の一覧を 1 回読み、 対象の全日を数え直して上書きする (一覧は軽い)。
// - コミット件数: 今日と昨日 (遅れて push されたコミットが増える) と、 まだ数えていない日だけ GitHub に聞く。
// GitHub が上限を返したらそこで止め、 残りは次の回に回す。 Revisor と GitHub はどちらかが失敗しても、 もう片方は保存する。

import { countMergesByDay } from './count-merges.js';
import { GithubRateLimitError } from './github-commit-count.js';
import { recentJstDays } from './jst-day.js';
import type { DailyThroughput, MergeCount, MergedPullRequest } from './types.js';

export interface CollectDeps {
  now: () => Date;
  days: number;
  fetchMerged: () => Promise<MergedPullRequest[]>;
  countCommits: (day: string) => Promise<number>;
  listDaily: (days: readonly string[]) => DailyThroughput[];
  saveMergeCount: (day: string, count: MergeCount, at: string) => void;
  saveCommitCount: (day: string, commits: number, at: string) => void;
  /** GitHub 検索の間隔を空ける待ち。 テストでは即時に差し替える */
  pause: () => Promise<void>;
}

export interface CollectResult {
  mergeDays: number;
  commitDays: number;
  errors: string[];
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** コミット件数を聞き直す日: 直近 2 日と、 件数が未保存の日。 */
export function daysNeedingCommitCount(days: readonly string[], stored: readonly DailyThroughput[]): string[] {
  const counted = new Set(stored.filter((row) => row.commits !== null).map((row) => row.day));
  return days.filter((day, index) => index < 2 || !counted.has(day));
}

export async function collectDevThroughput(deps: CollectDeps): Promise<CollectResult> {
  const days = recentJstDays(deps.now(), deps.days);
  const result: CollectResult = { mergeDays: 0, commitDays: 0, errors: [] };

  try {
    const counts = countMergesByDay(await deps.fetchMerged(), days);
    const at = deps.now().toISOString();
    for (const [day, count] of counts) deps.saveMergeCount(day, count, at);
    result.mergeDays = counts.size;
  } catch (error: unknown) {
    result.errors.push(`Revisor: ${message(error)}`);
  }

  const pending = daysNeedingCommitCount(days, deps.listDaily(days));
  for (const [index, day] of pending.entries()) {
    if (index > 0) await deps.pause();
    try {
      deps.saveCommitCount(day, await deps.countCommits(day), deps.now().toISOString());
      result.commitDays += 1;
    } catch (error: unknown) {
      result.errors.push(`GitHub ${day}: ${message(error)}`);
      if (error instanceof GithubRateLimitError) break;
    }
  }
  return result;
}
