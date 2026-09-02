// task-review — 期限超過の todo/doing タスクを Sonnet で棚卸しし、 統合候補 (cluster) と
// 完了候補 (completed) を task_reviews に pending で積む。
// 既定 scope は 'overdue' (期限超過のみ)。 期限未設定は task-triage セッションで扱う。
// Spec: spec/feature/task-review.md

import type BetterSqlite3 from 'better-sqlite3';
import { runLlm } from '../llm.js';
import {
  listTasks, insertTaskReview, deletePendingTaskReviews, listTaskReviews,
} from '../db.js';
import type { TaskRow } from '../db/types/task.js';
import type {
  TaskReview, TaskReviewSuggestions, ClusterSuggestion, CompletedSuggestion, TaskSnapshotEntry,
} from './types.js';
import { selectReviewTasks, type TaskReviewScope } from './scope.js';

type Db = BetterSqlite3.Database;

export interface RunTaskReviewResult {
  created: number;
  /** 棚卸し対象に入ったタスク数 (scope 適用後)。 */
  scanned: number;
  scope: TaskReviewScope;
  items: TaskReview[];
}

export interface RunTaskReviewOptions {
  scope?: TaskReviewScope;
  now?: Date;
}

/** 対象タスクを全件読む上限。 listTasks の既定 (100) では 400 件規模を取りこぼす。 */
const FETCH_LIMIT = 10_000;

/** LLM 出力 (```json フェンス等) から JSON オブジェクトを抜き出す。 失敗時 null。 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(candidate);
  if (direct) return direct;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const obj = tryParse(candidate.slice(start, end + 1));
    if (obj) return obj;
  }
  return null;
}

function coerceSuggestions(obj: Record<string, unknown> | null): TaskReviewSuggestions {
  const clusters: ClusterSuggestion[] = [];
  const completed: CompletedSuggestion[] = [];
  if (!obj) return { clusters, completed };
  if (Array.isArray(obj.clusters)) {
    for (const c of obj.clusters) {
      if (!c || typeof c !== 'object') continue;
      const o = c as Record<string, unknown>;
      const ids = Array.isArray(o.task_ids) ? o.task_ids.filter((x): x is number => typeof x === 'number') : [];
      const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
      if (ids.length < 2 || !reason) continue;
      clusters.push({
        project: typeof o.project === 'string' ? o.project : null,
        task_ids: ids,
        primary_id: typeof o.primary_id === 'number' ? o.primary_id : undefined,
        reason,
      });
    }
  }
  if (Array.isArray(obj.completed)) {
    for (const c of obj.completed) {
      if (!c || typeof c !== 'object') continue;
      const o = c as Record<string, unknown>;
      const id = typeof o.task_id === 'number' ? o.task_id : NaN;
      const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
      if (!Number.isFinite(id) || !reason) continue;
      completed.push({ task_id: id, reason });
    }
  }
  return { clusters, completed };
}

function buildPrompt(tasks: TaskRow[], scope: TaskReviewScope): string {
  // プロジェクト (category) ごとにまとめて提示。 category は複数値 (カンマ区切り) なので
  // 先頭値をグループキーにする。 未分類は「(未分類)」。
  const groups = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    const key = (t.category ?? '').split(',')[0].trim() || '(未分類)';
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }
  const lines: string[] = [];
  for (const [proj, arr] of groups) {
    lines.push(`### プロジェクト: ${proj}`);
    for (const t of arr) {
      const detail = (t.details ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const due = t.due_at ? ` (期限 ${t.due_at})` : '';
      lines.push(`- #${t.id} [${t.status}]${due} ${t.title}${detail ? ` — ${detail}` : ''}`);
    }
    lines.push('');
  }

  const intro = scope === 'overdue'
    ? 'あなたはタスク管理の整理係だ。 以下は **期限を過ぎた** 未完 (todo/doing) のタスク一覧をプロジェクト別に並べたものだ。'
    : 'あなたはタスク管理の整理係だ。 以下は未完 (todo/doing) のタスク一覧をプロジェクト別に並べたものだ。';
  return [
    intro,
    '2 種類の整理候補を JSON で出せ。 確証が持てるものだけ。 推測で増やさない。',
    '',
    '1. clusters: **同じプロジェクト内**で内容が近い/重複しているタスクのまとまり。',
    '   - task_ids は 2 件以上。 少しでも別作業なら **まとめない** (迷ったら出さない)。',
    '   - primary_id は統合先にすべき代表 1 件 (最も汎用的/包括的なもの)。',
    '2. completed: details や文面から **既に完了していそう**なタスク。 これからやる作業が明確に残るものは出さない。',
    '',
    '## タスク一覧',
    '',
    lines.join('\n').trim(),
    '',
    '## 出力形式 (厳守)',
    '次の JSON だけを返す (前後に説明文を付けない)。 該当が無ければ空配列にする:',
    '{ "clusters": [ { "project": "Anatomia", "task_ids": [322, 364], "primary_id": 322, "reason": "同じ動的トレース検証の残作業で重複" } ],',
    '  "completed": [ { "task_id": 299, "reason": "details に『マージ済』とあり実質完了" } ] }',
  ].join('\n');
}

/**
 * タスク棚卸しを実行する。 scope (既定 'overdue' = 期限超過のみ) で絞った todo/doing タスクを
 * Sonnet に渡して整理候補を得、 既存 pending を作り直して task_reviews に積む。
 */
export async function runTaskReview(
  db: Db, dateStr: string, opts: RunTaskReviewOptions = {},
): Promise<RunTaskReviewResult> {
  const scope: TaskReviewScope = opts.scope ?? 'overdue';
  const now = opts.now ?? new Date();
  const tasks = selectReviewTasks(listTasks(db, { kind: 'task', limit: FETCH_LIMIT }), scope, now);
  if (tasks.length < 2) {
    // 整理対象がほぼ無い。 pending を一掃するだけ (古い提案を残さない)。
    deletePendingTaskReviews(db);
    return { created: 0, scanned: tasks.length, scope, items: [] };
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const raw = await runLlm({ task: 'task_review', prompt: buildPrompt(tasks, scope) });
  const { clusters, completed } = coerceSuggestions(extractJsonObject(raw));

  const snapshotOf = (ids: number[]): TaskSnapshotEntry[] =>
    ids.map((id) => byId.get(id)).filter((t): t is TaskRow => !!t)
      .map((t) => ({ id: t.id, title: t.title, status: t.status }));

  // 解析が成功した後にだけ pending を作り直す (失敗時に既存提案を消さない)。
  deletePendingTaskReviews(db);
  let created = 0;

  for (const c of clusters) {
    // 実在 & 未完のみ。 重複 id を排除。
    const ids = [...new Set(c.task_ids)].filter((id) => byId.has(id) && byId.get(id)!.status !== 'done');
    if (ids.length < 2) continue;
    const primary = c.primary_id && ids.includes(c.primary_id) ? c.primary_id : ids[0];
    const projFromTask = (byId.get(primary)?.category ?? '').split(',')[0].trim();
    const project = c.project ?? (projFromTask || null);
    insertTaskReview(db, {
      kind: 'cluster',
      project,
      task_ids: ids,
      primary_id: primary,
      reason: c.reason,
      snapshot: snapshotOf(ids),
      for_date: dateStr,
    });
    created++;
  }

  for (const c of completed) {
    if (!byId.has(c.task_id) || byId.get(c.task_id)!.status === 'done') continue;
    insertTaskReview(db, {
      kind: 'completed',
      project: (byId.get(c.task_id)?.category ?? '').split(',')[0].trim() || null,
      task_ids: [c.task_id],
      primary_id: null,
      reason: c.reason,
      snapshot: snapshotOf([c.task_id]),
      for_date: dateStr,
    });
    created++;
  }

  return { created, scanned: tasks.length, scope, items: listTaskReviews(db, { status: 'pending' }) };
}
