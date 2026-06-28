// /api/task-reviews — タスク確認キュー (朝の Sonnet 棚卸し)。
// Spec: spec/feature/task-review.md §API

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { listTaskReviews, getTaskReview, setTaskReviewStatus } from '../db.js';
import { runTaskReview, applyTaskReview } from '../task-review/index.js';
import { formatLocalDate } from '../diary.js';

type Db = BetterSqlite3.Database;

export interface TaskReviewRouterDeps {
  db: Db;
}

export function makeTaskReviewRouter(deps: TaskReviewRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  r.get('/api/task-reviews', (c: Context) => {
    const statusQ = c.req.query('status');
    const status = statusQ === 'all' ? 'all'
      : (['pending', 'applied', 'dismissed'] as const).includes(statusQ as 'pending')
        ? (statusQ as 'pending' | 'applied' | 'dismissed')
        : 'pending';
    return c.json({ items: listTaskReviews(db, { status }) });
  });

  // いま棚卸し (手動実行)。 pending を作り直す。
  r.post('/api/task-reviews/run-now', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { date?: unknown };
    const date = typeof body.date === 'string' && body.date.trim() ? body.date.trim() : formatLocalDate();
    try {
      const result = await runTaskReview(db, date);
      return c.json(result);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // 適用 (圧縮)。 実行直前に存在/変更ガードを通し、 conflict なら 409。
  r.post('/api/task-reviews/:id/apply', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const result = applyTaskReview(db, id);
    if (result.ok) return c.json({ ok: true, review: result.review });
    if (result.code === 'not_found') return c.json({ error: result.error }, 404);
    if (result.code === 'conflict') return c.json({ error: result.error, conflicts: result.conflicts }, 409);
    return c.json({ error: result.error }, 400);
  });

  r.post('/api/task-reviews/:id/dismiss', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const review = getTaskReview(db, id);
    if (!review) return c.json({ error: 'not found' }, 404);
    setTaskReviewStatus(db, id, 'dismissed');
    return c.json({ ok: true });
  });

  return r;
}
