// Diary + weekly router (mounted at `/api`).
//
// Both share a router because they're a single feature surface: weekly is a
// roll-up of the daily diaries. The midnight + Sunday-evening crons stay in
// index.js (they need closure over enqueueDiary / enqueueWeekly which we also
// re-pass here as deps).
import { Hono } from 'hono';

export function createDiaryRouter({
  db,
  diaryQueue,
  enqueueDiary,
  enqueueWeekly,
  getDiary,
  listDiariesInRange,
  upsertDiary,
  deleteDiary,
  bookmarksForDate,
  digSessionsForDate,
  settingsAsObject,
  setDiarySettings,
  pingGithub,
  getWeekly,
  listWeeklyForMonth,
  deleteWeekly,
  weekRangeFor,
  weekOfMonth,
  aggregateDay,
}) {
  const router = new Hono();

  // ---- diary -------------------------------------------------------------

  router.get('/diary', (c) => {
    // ?month=YYYY-MM (defaults to current local month)
    const monthQ = c.req.query('month');
    const today = new Date();
    const monthStr = (monthQ && /^\d{4}-\d{2}$/.test(monthQ))
      ? monthQ
      : `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const start = `${monthStr}-01`;
    const [y, m] = monthStr.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    const end = `${monthStr}-${String(last).padStart(2, '0')}`;
    const items = listDiariesInRange(db, { start, end });
    return c.json({ month: monthStr, start, end, items });
  });

  router.get('/diary/settings', (c) => {
    // Mask the token when returning to the FE.
    const s = settingsAsObject();
    return c.json({
      github_user: s.github_user,
      github_repos: s.github_repos.join(','),
      github_token_set: !!s.github_token,
    });
  });

  router.post('/diary/settings', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const patch = {};
    if (typeof body.github_token === 'string') patch.github_token = body.github_token;
    if (typeof body.github_user === 'string') patch.github_user = body.github_user;
    if (typeof body.github_repos === 'string') patch.github_repos = body.github_repos;
    setDiarySettings(db, patch);
    return c.json({ ok: true });
  });

  /** Validate the saved GitHub PAT by hitting /user. */
  router.post('/diary/test-github', async (c) => {
    const s = settingsAsObject();
    if (!s.github_token) return c.json({ ok: false, error: 'no token saved' });
    const r = await pingGithub({ token: s.github_token, user: s.github_user });
    return c.json(r);
  });

  router.get('/diary/:date', (c) => {
    const date = c.req.param('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
    const entry = getDiary(db, date) || { date, status: 'absent' };
    // The stored row contains both `metrics_json` (raw text) AND its parsed
    // `metrics` object. We also compute fresh `live_metrics`. Sending all
    // three triples the payload — for a busy day that pushed the response
    // past 1.8 MB and made the Tauri WebView freeze. Keep only live_metrics
    // (which is what the SPA actually reads) and drop the redundancies.
    const { metrics_json: _mj, metrics: _m, ...slim } = entry;
    // listLimit defaults to 10 — keeps the response small enough for the
    // Tauri WebView even on days with hundreds of bookmarks. Full lists
    // come from /api/diary/:date/bookmarks and /api/diary/:date/digs.
    const liveMetrics = aggregateDay(db, date);
    return c.json({ ...slim, live_metrics: liveMetrics });
  });

  // Paginated bookmark list for the diary panel's "more ▽" button.
  //   ?kind=created|accessed&limit=20&offset=10
  router.get('/diary/:date/bookmarks', (c) => {
    const date = c.req.param('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
    const kind = c.req.query('kind') === 'accessed' ? 'accessed' : 'created';
    const limit = Math.min(Number(c.req.query('limit')) || 20, 200);
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
    const r = bookmarksForDate(db, date, { limit, offset });
    return c.json({
      items: r[kind],
      total: kind === 'accessed' ? r.accessed_total : r.created_total,
      offset, limit,
    });
  });

  // Paginated dig list for the diary panel.
  router.get('/diary/:date/digs', (c) => {
    const date = c.req.param('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
    const limit = Math.min(Number(c.req.query('limit')) || 20, 200);
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
    const all = digSessionsForDate(db, date);
    const slice = all.slice(offset, offset + limit).map(d => {
      const r = d.result || {};
      return {
        id: d.id, query: d.query, status: d.status, created_at: d.created_at,
        summary: (r.summary || '').slice(0, 600),
        source_count: (r.sources || []).length,
        sources: (r.sources || []).slice(0, 8).map(s => ({
          url: s.url, title: s.title, snippet: (s.snippet || '').slice(0, 200),
        })),
      };
    });
    return c.json({ items: slice, total: all.length, offset, limit });
  });

  router.post('/diary/:date/generate', async (c) => {
    const date = c.req.param('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
    // Body is optional. When present, `improve` is a one-shot instruction
    // appended to the prompt for this run only (not persisted).
    const body = await c.req.json().catch(() => null);
    enqueueDiary(date, { improve: body?.improve });
    return c.json({ queued: true, queue_depth: diaryQueue.depth });
  });

  router.patch('/diary/:date', async (c) => {
    const date = c.req.param('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.notes === 'string') {
      upsertDiary(db, { date, notes: body.notes });
    }
    return c.json(getDiary(db, date));
  });

  router.delete('/diary/:date', (c) => {
    const date = c.req.param('date');
    deleteDiary(db, date);
    return c.json({ ok: true });
  });

  // ---- weekly ------------------------------------------------------------

  router.get('/weekly', (c) => {
    const monthQ = c.req.query('month');
    const today = new Date();
    const monthStr = (monthQ && /^\d{4}-\d{2}$/.test(monthQ))
      ? monthQ
      : `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    return c.json({ month: monthStr, items: listWeeklyForMonth(db, monthStr) });
  });

  router.get('/weekly/:weekStart', (c) => {
    const ws = c.req.param('weekStart');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) return c.json({ error: 'invalid week_start' }, 400);
    const w = getWeekly(db, ws);
    if (!w) {
      const range = weekRangeFor(ws);
      const { weekInMonth, month } = weekOfMonth(range.start);
      return c.json({ week_start: range.start, week_end: range.end, month, week_in_month: weekInMonth, status: 'absent' });
    }
    return c.json(w);
  });

  router.post('/weekly/:weekStart/generate', (c) => {
    const ws = c.req.param('weekStart');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) return c.json({ error: 'invalid week_start' }, 400);
    const range = weekRangeFor(ws);
    enqueueWeekly(range.start);
    return c.json({ queued: true, week_start: range.start, week_end: range.end });
  });

  router.delete('/weekly/:weekStart', (c) => {
    const ws = c.req.param('weekStart');
    deleteWeekly(db, ws);
    return c.json({ ok: true });
  });

  return router;
}
