// task-review — 提案の適用 (圧縮)。 実行直前に対象タスクの存在/変更を再確認し、
// cluster は代表へ統合 + 残りを done クローズ、 completed は対象を done にする。
// Spec: spec/feature/task-review.md §存在確認 (圧縮前ガード)

import type BetterSqlite3 from 'better-sqlite3';
import { getTask, getTaskReview, updateTask, setTaskReviewStatus } from '../db.js';
import type { TaskRow } from '../db/types/task.js';
import type { TaskReview, TaskSnapshotEntry, SnapshotConflict } from './types.js';

type Db = BetterSqlite3.Database;

/**
 * 生成時スナップショットと現状タスクを突き合わせ、 不一致を列挙する純関数。
 * - 対象 id が現存しない → missing
 * - title / status がスナップショットと異なる → changed
 * これがあれば圧縮を一切行わない (朝の解析後にタスク修正が入っても安全に倒す)。
 */
export function detectSnapshotConflicts(
  snapshot: TaskSnapshotEntry[],
  current: Map<number, TaskRow | undefined>,
): SnapshotConflict[] {
  const conflicts: SnapshotConflict[] = [];
  for (const snap of snapshot) {
    const cur = current.get(snap.id);
    if (!cur) {
      conflicts.push({ id: snap.id, kind: 'missing' });
      continue;
    }
    if (cur.title !== snap.title || cur.status !== snap.status) {
      conflicts.push({ id: snap.id, kind: 'changed' });
    }
  }
  return conflicts;
}

export type ApplyTaskReviewResult =
  | { ok: true; review: TaskReview }
  | { ok: false; code: 'not_found' | 'not_pending' | 'invalid'; error: string }
  | { ok: false; code: 'conflict'; error: string; conflicts: SnapshotConflict[] };

/** review 1 件を適用する。 圧縮前に必ず存在/変更ガードを通す。 */
export function applyTaskReview(db: Db, id: number): ApplyTaskReviewResult {
  const review = getTaskReview(db, id);
  if (!review) return { ok: false, code: 'not_found', error: 'review not found' };
  if (review.status !== 'pending') return { ok: false, code: 'not_pending', error: `review is ${review.status}` };

  // 対象タスクの現状を取得 (snapshot に載る id すべて)。
  const current = new Map<number, TaskRow | undefined>();
  for (const snap of review.snapshot) current.set(snap.id, getTask(db, snap.id));

  const conflicts = detectSnapshotConflicts(review.snapshot, current);
  if (conflicts.length) {
    return { ok: false, code: 'conflict', error: 'tasks changed since analysis', conflicts };
  }

  if (review.kind === 'cluster') {
    const primaryId = review.primary_id;
    if (primaryId == null || !current.get(primaryId)) {
      return { ok: false, code: 'invalid', error: 'primary task missing' };
    }
    const primary = current.get(primaryId)!;
    const others = review.task_ids.filter((tid) => tid !== primaryId);
    // 代表タスクの details 末尾に統合元を追記する (履歴を残す)。
    const mergedLines = others.map((tid) => `統合: #${tid} ${current.get(tid)?.title ?? ''}`.trim());
    const newDetails = [primary.details?.trim() || '', ...mergedLines].filter(Boolean).join('\n');
    updateTask(db, primaryId, { details: newDetails });
    for (const tid of others) updateTask(db, tid, { status: 'done' });
  } else {
    // completed: 対象を done に。
    for (const tid of review.task_ids) updateTask(db, tid, { status: 'done' });
  }

  setTaskReviewStatus(db, id, 'applied', new Date().toISOString());
  const after = getTaskReview(db, id);
  return { ok: true, review: after ?? review };
}
