// task-review — 朝のタスク棚卸し tick。 ai-hub scheduler と同形:
// 毎分 setInterval で時刻を見て、 設定時刻 + 当日未実行 (app_settings の last_date
// ガード) のときだけ runTaskReview を走らせる。 try/catch で全体を止めない。
// Spec: spec/feature/task-review.md §トリガー

import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';
import { formatLocalDate } from '../diary.js';
import { runTaskReview } from './analyze.js';

type Db = BetterSqlite3.Database;

const DEFAULT_TIME = '08:00';

/** 'HH:MM' を {hour, minute} に。 不正なら既定 08:00。 */
function parseTime(raw: string | null | undefined): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec((raw || DEFAULT_TIME).trim());
  if (!m) return { hour: 8, minute: 0 };
  const hour = Math.min(23, Math.max(0, Number(m[1])));
  const minute = Math.min(59, Math.max(0, Number(m[2])));
  return { hour, minute };
}

/** '1' / 未設定 を enabled、 それ以外を disabled (既定 ON)。 */
function isEnabled(value: string | null | undefined): boolean {
  return value == null ? true : value === '1';
}

export function startTaskReviewScheduler(db: Db): void {
  const tick = () => {
    const now = new Date();
    const today = formatLocalDate(now);
    try {
      const appS = getAppSettings(db);
      if (!isEnabled(appS['task_review.enabled'])) return;
      const { hour, minute } = parseTime(appS['task_review.time']);
      if (now.getHours() === hour && now.getMinutes() === minute
          && appS['task_review.last_date'] !== today) {
        // 先にガードを立て (二重実行防止)、 非同期処理を投げる。
        setAppSettings(db, { 'task_review.last_date': today });
        void runTaskReview(db, today).catch((e: unknown) => {
          console.warn('[task-review] run failed:', e instanceof Error ? e.message : String(e));
        });
      }
    } catch (e: unknown) {
      console.warn('[task-review] tick failed:', e instanceof Error ? e.message : String(e));
    }
  };

  setInterval(() => { tick(); }, 60_000).unref?.();
}
