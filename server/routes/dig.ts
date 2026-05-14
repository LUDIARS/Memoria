// /api/dig* — Deep research (claude WebSearch / WebFetch を駆動して JSON で返す)。
// Spec: spec/api/dig.md

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  insertDigSession, getDigSession, listDigSessions, deleteDigSession,
  listDigThemes, listDigsForReview,
  type DigOriginReview,
} from '../db.js';
import { listSearchEngines, deriveDigTheme } from '../dig.js';
import type { BulkSaveDeps, BulkSaveResult } from '../lib/bulk-save.js';
import { bulkSaveUrls } from '../lib/bulk-save.js';

type Db = BetterSqlite3.Database;

export interface DigRouterDeps {
  db: Db;
  enqueueDig: (id: number, query: string, opts?: { searchEngine?: string; theme?: string | null }) => void;
  /** /api/dig/:id/save 用 — ブクマ enqueue を呼べる必要がある */
  bulkSaveDeps: BulkSaveDeps;
}

export function makeDigRouter(deps: DigRouterDeps): Hono {
  const { db, enqueueDig, bulkSaveDeps } = deps;
  const r = new Hono();

  r.post('/api/dig', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as
      | { query?: unknown; search_engine?: unknown; theme?: unknown;
          origin?: { kind?: unknown; repo?: unknown; date?: unknown; file?: unknown } | null }
      | null;
    const query = body?.query;
    if (!query || typeof query !== 'string') return c.json({ error: 'query required' }, 400);
    const searchEngine = typeof body?.search_engine === 'string' ? body.search_engine : 'default';
    // テーマ: フロントから明示指定があればそれを採用。 無ければ query から
    // 簡易抽出 (先頭の意味のあるフレーズ)。
    const theme = (typeof body?.theme === 'string' && body.theme.trim())
      ? body.theme.trim().slice(0, 60)
      : deriveDigTheme(query);
    let origin: DigOriginReview | null = null;
    const o = body?.origin;
    if (o && o.kind === 'review'
      && typeof o.repo === 'string' && typeof o.date === 'string' && typeof o.file === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(o.date)) {
      origin = { kind: 'review', repo: o.repo, date: o.date, file: o.file };
    }
    const id = insertDigSession(db, query, theme, origin);
    enqueueDig(id, query, { searchEngine, theme });
    return c.json({ id, queued: true, theme, search_engine: searchEngine, origin });
  });

  /** レビューファイル発の dig 履歴一覧 (新しい順)。 レビュー画面の各タブで再表示用。 */
  r.get('/api/dig/by-review', (c: Context) => {
    const url = new URL(c.req.url);
    const repo = url.searchParams.get('repo') ?? '';
    const date = url.searchParams.get('date') ?? '';
    const file = url.searchParams.get('file') ?? '';
    if (!repo || !date || !file) return c.json({ error: 'repo / date / file required' }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'date YYYY-MM-DD' }, 400);
    return c.json({ items: listDigsForReview(db, { repo, date, file }) });
  });

  r.get('/api/dig/engines', (c: Context) => {
    return c.json({ items: listSearchEngines() });
  });

  r.get('/api/dig/themes', (c: Context) => {
    return c.json({ items: listDigThemes(db) });
  });

  r.get('/api/dig', (c: Context) => {
    const theme = c.req.query('theme');
    return c.json({ items: listDigSessions(db, theme ? { theme } : {}) });
  });

  r.get('/api/dig/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    const s = getDigSession(db, id);
    if (!s) return c.json({ error: 'not found' }, 404);
    return c.json(s);
  });

  // Delete a 誤 Dig. The row goes; downstream references (word_clouds
  // origin_dig_id, dictionary_links source_kind='dig') become orphan and the
  // existing UI handles missing sessions gracefully.
  r.delete('/api/dig/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const removed = deleteDigSession(db, id);
    if (!removed) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true, id });
  });

  r.post('/api/dig/:id/save', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as { urls?: unknown } | null;
    if (!body || !Array.isArray(body.urls)) return c.json({ error: 'urls[] required' }, 400);
    const results: BulkSaveResult[] = await bulkSaveUrls(bulkSaveDeps, body.urls);
    return c.json({ results });
  });

  return r;
}
