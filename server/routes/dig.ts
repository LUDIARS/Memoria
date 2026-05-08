// /api/dig* — Deep research (claude WebSearch / WebFetch を駆動して JSON で返す)。
// Spec: spec/api/dig.md

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  insertDigSession, getDigSession, listDigSessions, deleteDigSession,
  listDigThemes,
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
      | { query?: unknown; search_engine?: unknown; theme?: unknown }
      | null;
    const query = body?.query;
    if (!query || typeof query !== 'string') return c.json({ error: 'query required' }, 400);
    const searchEngine = typeof body?.search_engine === 'string' ? body.search_engine : 'default';
    // テーマ: フロントから明示指定があればそれを採用。 無ければ query から
    // 簡易抽出 (先頭の意味のあるフレーズ)。
    const theme = (typeof body?.theme === 'string' && body.theme.trim())
      ? body.theme.trim().slice(0, 60)
      : deriveDigTheme(query);
    const id = insertDigSession(db, query, theme);
    enqueueDig(id, query, { searchEngine, theme });
    return c.json({ id, queued: true, theme, search_engine: searchEngine });
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
