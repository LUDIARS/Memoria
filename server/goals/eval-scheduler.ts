import type BetterSqlite3 from 'better-sqlite3';
import { listTasks, getAppSettings, setAppSettings } from '../db.js';
import { formatLocalDate } from '../diary.js';
import { upsertGoalEvalLog } from './eval-db.js';

type Db = BetterSqlite3.Database;

export function startGoalEvalScheduler(db: Db): void {
  const tick = () => {
    try {
      const now = new Date();
      if (now.getHours() !== 7 || now.getMinutes() !== 0) return;

      const today = formatLocalDate(now);
      const appS = getAppSettings(db);
      if (appS['goals.eval.last_date'] === today) return;

      const goals = listTasks(db, { kind: 'goal', limit: 200 });
      for (const goal of goals) {
        upsertGoalEvalLog(db, { goalId: goal.id, date: today, status: goal.status });
      }
      setAppSettings(db, { 'goals.eval.last_date': today });
      console.log(`[goals eval] snapshotted ${goals.length} goals for ${today}`);
    } catch (e: unknown) {
      console.warn('[goals eval] tick failed:', e instanceof Error ? e.message : String(e));
    }
  };

  setInterval(() => { tick(); }, 60_000).unref?.();
}
