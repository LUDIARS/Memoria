// /share + /api/export + /api/import — その他の小物 endpoint。
// Spec: spec/api/misc.md (一部) — uptime / events / queue は visit.ts / config.ts。

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  getBookmark, listBookmarks, insertImportedBookmark,
} from '../db.js';
import type { BulkSaveDeps } from '../lib/bulk-save.js';
import { bulkSaveUrls } from '../lib/bulk-save.js';

type Db = BetterSqlite3.Database;

export interface MiscRouterDeps {
  db: Db;
  htmlDir: string;
  bulkSaveDeps: BulkSaveDeps;
}

export function makeMiscRouter(deps: MiscRouterDeps): Hono {
  const { db, htmlDir, bulkSaveDeps } = deps;
  const r = new Hono();

  // ---- export / import ------------------------------------------------------

  r.post('/api/export', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { ids?: unknown; includeHtml?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : null;
    const includeHtml = body.includeHtml !== false; // default true
    const all = ids
      ? ids.map((id) => getBookmark(db, id)).filter((b): b is NonNullable<typeof b> => !!b)
      : listBookmarks(db);
    const items = all.map((b) => {
      const out: Record<string, unknown> = {
        url: b.url,
        title: b.title,
        summary: b.summary,
        memo: b.memo,
        categories: b.categories,
        created_at: b.created_at,
        last_accessed_at: b.last_accessed_at,
        access_count: b.access_count,
      };
      if (includeHtml) {
        try {
          out.html = readFileSync(join(htmlDir, b.html_path), 'utf8');
        } catch { out.html = null; }
      }
      return out;
    });
    return c.json({
      version: 1,
      exported_at: new Date().toISOString(),
      bookmarks: items,
    });
  });

  r.post('/api/import', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as { bookmarks?: unknown } | null;
    if (!body || !Array.isArray(body.bookmarks)) return c.json({ error: 'bookmarks[] required' }, 400);
    const results = { imported: 0, skipped: 0, ids: [] as number[] };
    for (const raw of body.bookmarks as Record<string, unknown>[]) {
      if (!raw?.url || typeof raw.url !== 'string') continue;
      let htmlName = '';
      if (typeof raw.html === 'string' && raw.html.length > 0) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        htmlName = ts + '_' + Math.random().toString(36).slice(2, 8) + '.html';
        writeFileSync(join(htmlDir, htmlName), raw.html, 'utf8');
      }
      const r2 = insertImportedBookmark(db, {
        url: raw.url,
        title: typeof raw.title === 'string' ? raw.title : raw.url,
        summary: typeof raw.summary === 'string' ? raw.summary : null,
        memo: typeof raw.memo === 'string' ? raw.memo : null,
        categories: Array.isArray(raw.categories) ? raw.categories.map(String) : [],
        html_path: htmlName,
      });
      if (r2.skipped) results.skipped++;
      else { results.imported++; results.ids.push(r2.id); }
    }
    return c.json(results);
  });

  // ---- PWA Web Share Target -------------------------------------------------
  //
  // PWA share_target (manifest.webmanifest) routes the OS share sheet here on
  // Android. iOS has no PWA share_target — the iOS Shortcut template in
  // docs/mobile-share.md drives this same endpoint instead.
  //
  // Inputs (all optional, supplied by the share sheet):
  //   ?title=…  ?text=…  ?url=…
  // We extract the first http(s) URL we can find, kick off a server-side fetch
  // + summarize via the existing bulk-save path, then redirect back to the SPA.
  r.get('/share', async (c: Context) => {
    const q = new URL(c.req.url).searchParams;
    const target = extractShareUrl(q);
    if (!target) {
      return c.redirect('/?share=invalid', 303);
    }
    // Fire-and-forget — bulkSaveUrls handles dedup and queues the summary.
    bulkSaveUrls(bulkSaveDeps, [target]).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[share] bulkSaveUrls failed:', msg);
    });
    return c.redirect('/?share=ok&u=' + encodeURIComponent(target), 303);
  });

  return r;
}

function extractShareUrl(q: URLSearchParams): string | null {
  const direct = (q.get('url') || '').trim();
  if (/^https?:\/\//i.test(direct)) return direct;
  for (const key of ['text', 'title']) {
    const v = (q.get(key) || '').trim();
    const m = v.match(/https?:\/\/\S+/i);
    if (m) return m[0].replace(/[.,;:!?)\]]+$/g, '');
  }
  return null;
}
