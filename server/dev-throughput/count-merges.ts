// Revisor のマージ済み PR を JST の日ごとに数える純関数。
// Revisor の一覧 (view=summary) はマージ時刻を持たないので、 マージ済み PR の updatedAt をマージ日とする
// (マージが最後の更新になる。 マージ後に記録が更新された PR は後ろの日へずれることがある)。

import { jstDayOf } from './jst-day.js';
import type { MergeCount, MergedPullRequest } from './types.js';

export function countMergesByDay(pullRequests: readonly MergedPullRequest[], days: readonly string[]): Map<string, MergeCount> {
  const counts = new Map<string, MergeCount>(days.map((day) => [day, { total: 0, byRepo: {} }]));
  for (const pr of pullRequests) {
    if (pr.status !== 'merged') continue;
    const day = jstDayOf(pr.updatedAt);
    const count = day ? counts.get(day) : undefined;
    if (!count) continue;
    count.total += 1;
    count.byRepo[pr.repository] = (count.byRepo[pr.repository] ?? 0) + 1;
  }
  return counts;
}
