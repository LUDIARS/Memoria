import { listTasks } from '../tasks/store.js';
import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export interface GoalEvalLog {
  id: number;
  goal_id: number;
  date: string;
  status: string;
  evaluated_at: string;
  goal_title: string | null;
}

export function upsertGoalEvalLog(
  db: Db,
  { goalId, date, status }: { goalId: number; date: string; status: string },
): void {
  db.prepare(`
    INSERT INTO goal_eval_logs (goal_id, date, status)
    VALUES (?, ?, ?)
    ON CONFLICT(goal_id, date) DO UPDATE SET
      status = excluded.status,
      evaluated_at = datetime('now')
  `).run(goalId, date, status);
}

export async function listGoalEvalLogs(db: Db, month: string): Promise<GoalEvalLog[]> {
  const goals = new Map((await listTasks(db, { kind: 'all', limit: Number.MAX_SAFE_INTEGER })).map(task => [task.id, task.title]));
  const logs = db.prepare(`
    SELECT g.id, g.goal_id, g.date, g.status, g.evaluated_at,
           NULL AS goal_title
    FROM goal_eval_logs g
    WHERE g.date LIKE ?
    ORDER BY g.goal_id, g.date
  `).all(`${month}%`) as GoalEvalLog[];
  return logs.map(log => ({ ...log, goal_title: goals.get(log.goal_id) ?? null }));
}
