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

export function listGoalEvalLogs(db: Db, month: string): GoalEvalLog[] {
  return db.prepare(`
    SELECT g.id, g.goal_id, g.date, g.status, g.evaluated_at,
           t.title AS goal_title
    FROM goal_eval_logs g
    LEFT JOIN tasks t ON t.id = g.goal_id
    WHERE g.date LIKE ?
    ORDER BY g.goal_id, g.date
  `).all(`${month}%`) as GoalEvalLog[];
}
