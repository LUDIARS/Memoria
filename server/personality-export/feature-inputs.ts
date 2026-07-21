// Personality export の集計対象期間を DB 行へ適用し、本文を除いた narrow input に変換する。

import type BetterSqlite3 from 'better-sqlite3';
import { listTasks, listDiariesInRange, listActivityEvents } from '../db.js';
import type { ActivityFeatureInput, DiaryFeatureInput, TaskFeatureInput } from './features.js';

type Db = BetterSqlite3.Database;

export const PERSONALITY_SAMPLE_WINDOW_DAYS = 90;

const MAX_TASK_SAMPLE = 5000;
const MAX_ACTIVITY_SAMPLE = 2000;

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isWithinWindow(timestamp: string, startMs: number, endMs: number): boolean {
  const valueMs = new Date(timestamp).getTime();
  return Number.isFinite(valueMs) && valueMs >= startMs && valueMs <= endMs;
}

export function gatherPersonalityFeatureInputs(
  db: Db,
  now: Date,
): { tasks: TaskFeatureInput[]; diaries: DiaryFeatureInput[]; activities: ActivityFeatureInput[] } {
  const endMs = now.getTime();
  const startMs = endMs - PERSONALITY_SAMPLE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const start = new Date(startMs);

  const tasks: TaskFeatureInput[] = listTasks(db, { kind: 'all', limit: MAX_TASK_SAMPLE })
    .filter((task) => isWithinWindow(task.created_at, startMs, endMs))
    .map((task) => ({
      status: task.status,
      kind: task.kind,
      created_at: task.created_at,
      due_at: task.due_at,
      category: task.category,
    }));

  // diary.date はローカル日付キー。 UTC 日付へ変換すると UTC+ の深夜帯で当日分が欠落する。
  const diaries: DiaryFeatureInput[] = listDiariesInRange(db, {
    start: formatLocalDate(start),
    end: formatLocalDate(now),
  }).map((diary) => ({ date: diary.date, work_minutes: diary.work_minutes }));

  const activities: ActivityFeatureInput[] = listActivityEvents(db, { limit: MAX_ACTIVITY_SAMPLE })
    .filter((activity) => isWithinWindow(activity.occurred_at, startMs, endMs))
    .map((activity) => ({ kind: activity.kind, occurred_at: activity.occurred_at }));

  return { tasks, diaries, activities };
}
