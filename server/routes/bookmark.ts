// /api/bookmark* — ブックマーク CRUD + URL から fetch + 要約キュー投入。
// Spec: spec/api/bookmark.md

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  insertBookmark, setSummary,
  listBookmarks, countBookmarks, getBookmark,
  updateMemoAndCategories, deleteBookmark,
  recordAccess, findBookmarkByUrl, listAccesses,
  getBookmarkWordCloud,
  insertPageMetadataPending, setPageMetadata,
} from '../db.js';
import type { FifoQueue } from '../queue.js';
import { parseOgFromHtml } from '../url-preview.js';
import { featureEnabled } from '../lib/privacy.js';

type Db = BetterSqlite3.Database;

interface FetchedPageHtml {
  html: string;
  title: string;
}

export interface BookmarkRouterDeps {
  db: Db;
  htmlDir: string;
  summaryQueue: FifoQueue;
  enqueueSummary: (id: number) => void;
  fetchPageHtml: (url: string, timeoutMs?: number) => Promise<FetchedPageHtml>;
}

export function makeBookmarkRouter(deps: BookmarkRouterDeps): Hono {
  const { db, htmlDir, summaryQueue, enqueueSummary, fetchPageHtml } = deps;
  const r = new Hono();

  r.post('/api/bookmark', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as
      | { html?: unknown; url?: unknown; title?: unknown }
      | null;
    if (!body || typeof body.html !== 'string' || typeof body.url !== 'string') {
      return c.json({ error: 'html, url, title required' }, 400);
    }
    const url = body.url;
    const title = (typeof body.title === 'string' ? body.title : url).slice(0, 500);
    const html = body.html;

    const existing = findBookmarkByUrl(db, url);
    if (existing) {
      // Same URL — record access and return existing.
      recordAccess(db, existing.id);
      return c.json({ id: existing.id, duplicate: true });
    }

    // Save HTML to disk first, then DB row, then kick off summarization.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = ts + '_' + Math.random().toString(36).slice(2, 8) + '.html';
    const htmlPath = join(htmlDir, safe);
    writeFileSync(htmlPath, html, 'utf8');

    const id = insertBookmark(db, { url, title, htmlPath: safe });

    // First access = creation.
    recordAccess(db, id);

    // Hand off to the FIFO queue so summarizations run strictly one at a time.
    // 自動要約は `features.bookmarks.auto_summarize` で opt-out 可。 保存は常に走るので
    // 後から「再要約」 ボタンを押せば手動で起動できる。
    if (featureEnabled(db, 'bookmarks_auto_summarize')) {
      enqueueSummary(id);
    }

    // Plan B: extension が rendered DOM をそのまま送ってきているので、 OG metadata
    // を server-side で抽出して page_metadata 行にキャッシュしておく。 後で note
    // editor の /api/notes/url-preview がこれを最優先で返す (= server-side OG fetch
    // よりも extension scrape が常に勝つ)。
    try {
      const og = parseOgFromHtml(html, url);
      insertPageMetadataPending(db, url);
      setPageMetadata(db, url, {
        title: og.title || title || null,
        og_title: og.title || null,
        og_description: og.description || null,
        og_image: og.image,
        og_type: og.og_type,
        status: 'extension-scraped',
      });
    } catch (e) {
      // OG 抽出は best-effort。 失敗しても bookmark 保存自体は成功とする。
      console.warn('[bookmark] og extract failed for', url, e);
    }

    return c.json({ id, queued: true, queueDepth: summaryQueue.depth });
  });

  r.get('/api/bookmarks', (c: Context) => {
    // Pagination: bookmark count grew enough that returning every row + every
    // category lookup got noticeably slow. The UI now requests 50 at a time
    // (with `?q=` for server-side search) and asks for the next page on
    // demand. Internal callers (export / wordcloud / recommendations) skip
    // the limit and keep getting the full array.
    const category = c.req.query('category') || undefined;
    const sortQ = c.req.query('sort');
    const validSorts = ['created_desc', 'created_asc', 'accessed_desc', 'accessed_asc', 'title_asc'] as const;
    const sort = (validSorts as readonly string[]).includes(sortQ ?? '') ? sortQ as typeof validSorts[number] : undefined;
    const q = c.req.query('q')?.trim() || undefined;
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50));
    const offset = Math.max(0, Number(c.req.query('offset')) || 0);
    const items = listBookmarks(db, { category, sort, q, limit, offset });
    const total = countBookmarks(db, { category, q });
    return c.json({ items, total, limit, offset });
  });

  r.get('/api/bookmarks/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    const b = getBookmark(db, id);
    if (!b) return c.json({ error: 'not found' }, 404);
    const cloud = getBookmarkWordCloud(db, id);
    return c.json({ ...b, wordcloud: cloud });
  });

  r.patch('/api/bookmarks/:id', async (c: Context) => {
    const id = Number(c.req.param('id'));
    const b = getBookmark(db, id);
    if (!b) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as { memo?: unknown; categories?: unknown };
    updateMemoAndCategories(db, id, {
      memo: typeof body.memo === 'string' ? body.memo : undefined,
      categories: Array.isArray(body.categories) ? body.categories.map(String) : undefined,
    });
    return c.json(getBookmark(db, id));
  });

  r.delete('/api/bookmarks/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    const htmlName = deleteBookmark(db, id);
    if (htmlName) {
      const p = join(htmlDir, htmlName);
      try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
    }
    return c.json({ ok: true });
  });

  r.post('/api/bookmarks/:id/resummarize', async (c: Context) => {
    const id = Number(c.req.param('id'));
    const b = getBookmark(db, id);
    if (!b) return c.json({ error: 'not found' }, 404);
    const htmlPath = join(htmlDir, b.html_path);
    if (!existsSync(htmlPath)) return c.json({ error: 'html file missing' }, 404);

    // Keep the existing summary visible while regeneration runs.
    setSummary(db, id, { summary: b.summary, status: 'pending', error: null });

    enqueueSummary(id);

    return c.json({ ok: true, queued: true, queueDepth: summaryQueue.depth });
  });

  r.get('/api/bookmarks/:id/html', (c: Context) => {
    const id = Number(c.req.param('id'));
    const b = getBookmark(db, id);
    if (!b) return c.text('not found', 404);
    const p = join(htmlDir, b.html_path);
    if (!existsSync(p)) return c.text('html missing', 404);
    return c.body(readFileSync(p), 200, { 'Content-Type': 'text/html; charset=utf-8' });
  });

  r.get('/api/bookmarks/:id/accesses', (c: Context) => {
    const id = Number(c.req.param('id'));
    return c.json({ items: listAccesses(db, id) });
  });

  // ---- ブックマーク: 単一 URL から fetch + 要約キュー投入 -------------------
  //
  // UI の「+ ブックマーク追加」用 endpoint。 内容取得失敗ならエラーを返す。
  r.post('/api/bookmarks/from-url', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as { url?: unknown } | null;
    const url = String(body?.url ?? '').trim();
    if (!url || !/^https?:\/\//i.test(url)) return c.json({ error: 'url (http/https) required' }, 400);
    const existing = findBookmarkByUrl(db, url);
    if (existing) return c.json({ duplicate: true, id: existing.id });
    try {
      const fetched = await fetchPageHtml(url);
      const title = (fetched.title || url).slice(0, 500);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const safe = ts + '_' + Math.random().toString(36).slice(2, 8) + '.html';
      writeFileSync(join(htmlDir, safe), fetched.html, 'utf8');
      const id = insertBookmark(db, { url, title, htmlPath: safe });
      recordAccess(db, id);
      enqueueSummary(id);
      return c.json({ id, title, queued: true, queueDepth: summaryQueue.depth }, 201);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `fetch / save failed: ${msg}` }, 502);
    }
  });

  return r;
}
