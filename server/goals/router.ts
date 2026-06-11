import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { listGoalEvalLogs } from './eval-db.js';
import { formatLocalDate } from '../diary.js';

type Db = BetterSqlite3.Database;

export interface GoalEvalRouterDeps {
  db: Db;
}

export function makeGoalEvalRouter(deps: GoalEvalRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  r.get('/api/goal-evals', (c: Context) => {
    const now = new Date();
    const month = c.req.query('month') ?? formatLocalDate(now).slice(0, 7);
    const logs = listGoalEvalLogs(db, month);
    return c.json(logs);
  });

  return r;
}
