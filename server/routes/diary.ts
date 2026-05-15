// /api/diary*, /api/weekly* — 日記 / 週次レポート。
// Spec: spec/api/diary.md

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  getDiary, listDiariesInRange, upsertDiary, deleteDiary,
  getDiarySettings, setDiarySettings, diaryRepos,
  getWeekly, listWeeklyForMonth, deleteWeekly,
  digSessionsForDate,
} from '../db.js';
import {
  aggregateDay, bookmarksForDate, pingGithub, weekRangeFor, weekOfMonth,
} from '../diary.js';
import type { FifoQueue } from '../queue.js';

type Db = BetterSqlite3.Database;

interface DigResultJson {
  summary?: string;
  sources?: { url?: string; title?: string; snippet?: string }[];
}

export interface DiaryRouterDeps {
  db: Db;
  diaryQueue: FifoQueue;
  enqueueDiary: (dateStr: string, opts?: { improve?: string }) => void;
  enqueueWeekly: (weekStart: string) => void;
}

export function makeDiaryRouter(deps: DiaryRouterDeps): Hono {
  const { db, diaryQueue, enqueueDiary, enqueueWeekly } = deps;
  const r = new Hono();

  function settingsAsObject() {
    const s = getDiarySettings(db);
    return {
      github_token: s.github_token || process.env.MEMORIA_GH_TOKEN || '',
      github_user: s.github_user || process.env.MEMORIA_GH_USER || '',
      // 集計対象リポは `📋 作業一覧` (repo_watch) から導出。 旧 diary_settings.github_repos は不使用。
      github_repos: diaryRepos(db),
    };
  }

  r.get('/api/diary', (c: Context) => {
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

  r.get('/api/diary/settings', (c: Context) => {
    // Mask the token when returning to the FE.
    // github_repos は `📋 作業一覧` (repo_watch) からの導出値を参考表示として返す
    // (フロント設定 UI では編集対象外)。
    const s = settingsAsObject();
    return c.json({
      github_user: s.github_user,
      github_repos: s.github_repos,           // 導出値 (string[])
      github_token_set: !!s.github_token,
    });
  });

  r.post('/api/diary/settings', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as
      { github_token?: unknown; github_user?: unknown };
    const patch: Record<string, string> = {};
    if (typeof body.github_token === 'string') patch.github_token = body.github_token;
    if (typeof body.github_user === 'string') patch.github_user = body.github_user;
    // github_repos は repo_watch 側で管理するため受け付けない (旧キーは無視)。
    setDiarySettings(db, patch);
    return c.json({ ok: true });
  });

  /** Validate the saved GitHub PAT by hitting /user. */
  r.post('/api/diary/test-github', async (c: Context) => {
    const s = settingsAsObject();
    if (!s.github_token) return c.json({ ok: false, error: 'no token saved' });
    const r2 = await pingGithub({ token: s.github_token, user: s.github_user });
    return c.json(r2);
  });

  r.get('/api/diary/:date', (c: Context) => {
    const date = c.req.param('date') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
    const entry = getDiary(db, date) ?? { date, status: 'absent' as const };
    // The stored row contains both `metrics_json` (raw text) AND its parsed
    // `metrics` object. We also compute fresh `live_metrics`. Sending all
    // three triples the payload — for a busy day that pushed the response
    // past 1.8 MB and made the Tauri WebView freeze. Keep only live_metrics
    // (which is what the SPA actually reads) and drop the redundancies.
    const slim = { ...entry } as Record<string, unknown>;
    delete slim.metrics_json;
    delete slim.metrics;
    // listLimit defaults to 10 — keeps the response small enough for the
    // Tauri WebView even on days with hundreds of bookmarks. Full lists
    // come from /api/diary/:date/bookmarks and /api/diary/:date/digs.
    const liveMetrics = aggregateDay(db, date);
    return c.json({ ...slim, live_metrics: liveMetrics });
  });

  // Paginated bookmark list for the diary panel's "more ▽" button.
  //   ?kind=created|accessed&limit=20&offset=10
  r.get('/api/diary/:date/bookmarks', (c: Context) => {
    const date = c.req.param('date') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
    const kind = c.req.query('kind') === 'accessed' ? 'accessed' : 'created';
    const limit = Math.min(Number(c.req.query('limit')) || 20, 200);
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
    const r2 = bookmarksForDate(db, date, { limit, offset });
    return c.json({
      items: r2[kind],
      total: kind === 'accessed' ? r2.accessed_total : r2.created_total,
      offset, limit,
    });
  });

  // Paginated dig list for the diary panel.
  r.get('/api/diary/:date/digs', (c: Context) => {
    const date = c.req.param('date') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
    const limit = Math.min(Number(c.req.query('limit')) || 20, 200);
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
    const all = digSessionsForDate(db, date);
    const slice = all.slice(offset, offset + limit).map((d) => {
      const result = (d.result ?? {}) as DigResultJson;
      return {
        id: d.id, query: d.query, status: d.status, created_at: d.created_at,
        summary: (result.summary ?? '').slice(0, 600),
        source_count: (result.sources ?? []).length,
        sources: (result.sources ?? []).slice(0, 8).map((s) => ({
          url: s.url, title: s.title, snippet: (s.snippet ?? '').slice(0, 200),
        })),
      };
    });
    return c.json({ items: slice, total: all.length, offset, limit });
  });

  r.post('/api/diary/:date/generate', async (c: Context) => {
    const date = c.req.param('date') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
    // Body is optional. When present, `improve` is a one-shot instruction
    // appended to the prompt for this run only (not persisted).
    const body = await c.req.json().catch(() => null) as { improve?: unknown } | null;
    const improve = typeof body?.improve === 'string' ? body.improve : undefined;
    enqueueDiary(date, { improve });
    return c.json({ queued: true, queue_depth: diaryQueue.depth });
  });

  r.patch('/api/diary/:date', async (c: Context) => {
    const date = c.req.param('date') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
    const body = await c.req.json().catch(() => ({})) as { notes?: unknown };
    if (typeof body.notes === 'string') {
      upsertDiary(db, { date, notes: body.notes });
    }
    return c.json(getDiary(db, date));
  });

  r.delete('/api/diary/:date', (c: Context) => {
    const date = c.req.param('date') ?? '';
    deleteDiary(db, date);
    return c.json({ ok: true });
  });

  // ---- weekly report --------------------------------------------------------

  r.get('/api/weekly', (c: Context) => {
    const monthQ = c.req.query('month');
    const today = new Date();
    const monthStr = (monthQ && /^\d{4}-\d{2}$/.test(monthQ))
      ? monthQ
      : `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    return c.json({ month: monthStr, items: listWeeklyForMonth(db, monthStr) });
  });

  r.get('/api/weekly/:weekStart', (c: Context) => {
    const ws = c.req.param('weekStart') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) return c.json({ error: 'invalid week_start' }, 400);
    const w = getWeekly(db, ws);
    if (!w) {
      const range = weekRangeFor(ws);
      const { weekInMonth, month } = weekOfMonth(range.start);
      return c.json({ week_start: range.start, week_end: range.end, month, week_in_month: weekInMonth, status: 'absent' });
    }
    return c.json(w);
  });

  r.post('/api/weekly/:weekStart/generate', (c: Context) => {
    const ws = c.req.param('weekStart') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) return c.json({ error: 'invalid week_start' }, 400);
    const range = weekRangeFor(ws);
    enqueueWeekly(range.start);
    return c.json({ queued: true, week_start: range.start, week_end: range.end });
  });

  r.delete('/api/weekly/:weekStart', (c: Context) => {
    const ws = c.req.param('weekStart') ?? '';
    deleteWeekly(db, ws);
    return c.json({ ok: true });
  });

  return r;
}
