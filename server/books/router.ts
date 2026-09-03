// /api/books/* — 蔵書 CRUD、 新刊、 サジェスト、 読破記録インポート、 設定。
// 同一マシンからのみ (shopping / release-watch と同じガード)。

import type BetterSqlite3 from 'better-sqlite3';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { isSameMachineRequest } from '../lib/local-request.js';
import {
  booksConfigSchema, getBooksConfig, getBooksImportState,
  maskRakutenId, mergeRakutenId, setBooksConfig,
} from './config.js';
import { booksJobCoordinator } from './coordinator.js';
import { importReadingRecords } from './import.js';
import { lookupBibliography } from './lookup.js';
import { ensureBooksSchema } from './schema.js';
import { runWeeklyBooksJob } from './scheduler.js';
import { checkNewReleases } from './new-release.js';
import { generateSuggestions } from './suggest.js';
import {
  countBooks, deleteBook, dismissNewRelease, dismissSuggestion, insertBook,
  listBooks, listNewReleases, listSuggestions, updateBook,
} from './store.js';
import { deriveWatchTargets } from './watch.js';

type Db = BetterSqlite3.Database;

export interface BooksRouterDeps {
  db: Db;
}

const httpUrlSchema = z.string().trim().max(500).url().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}, { message: 'HTTP(S) URL without embedded credentials required' });

const bookInputSchema = z.object({
  isbn13: z.string().trim().max(20).nullable().optional(),
  asin: z.string().trim().max(20).nullable().optional(),
  title: z.string().trim().min(1).max(300),
  authors: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  publisher: z.string().trim().max(120).nullable().optional(),
  series: z.string().trim().max(200).nullable().optional(),
  publishedOn: z.string().trim().max(20).nullable().optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  review: z.string().max(4_000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  readOn: z.string().trim().max(20).nullable().optional(),
  coverUrl: httpUrlSchema.nullable().optional(),
});

const bookPatchSchema = bookInputSchema.partial();

const importSchema = z.object({
  text: z.string().min(1).max(20 * 1024 * 1024),
  format: z.enum(['auto', 'csv', 'clippings']).default('auto'),
});

const searchSchema = z.object({
  query: z.string().trim().min(1).max(200),
  author: z.string().trim().min(1).max(120).optional(),
});

const listQuerySchema = z.object({
  minRating: z.coerce.number().int().min(1).max(5).optional(),
  q: z.string().trim().max(200).optional(),
  tag: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(1_000).default(200),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

function positiveId(raw: string | undefined): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function makeBooksRouter(deps: BooksRouterDeps): Hono {
  const router = new Hono();
  ensureBooksSchema(deps.db);

  router.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    if (!isSameMachineRequest(context)) {
      return context.json({ error: 'same-machine access required' }, 403);
    }
    await next();
  });

  // ── 蔵書 ──────────────────────────────────────────────────────
  router.get('/api/books', (context: Context) => {
    const url = new URL(context.req.url);
    const parsed = listQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return context.json({ error: 'invalid books query', issues: parsed.error.issues }, 400);
    return context.json({
      books: listBooks(deps.db, {
        minRating: parsed.data.minRating,
        query: parsed.data.q || undefined,
        tag: parsed.data.tag || undefined,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      }),
      counts: countBooks(deps.db),
    });
  });

  router.post('/api/books', async (context: Context) => {
    const parsed = bookInputSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: 'invalid book', issues: parsed.error.issues }, 400);
    return context.json({ book: insertBook(deps.db, parsed.data) }, 201);
  });

  router.patch('/api/books/:id', async (context: Context) => {
    const id = positiveId(context.req.param('id'));
    if (id === null) return context.json({ error: 'invalid book id' }, 400);
    const parsed = bookPatchSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: 'invalid patch', issues: parsed.error.issues }, 400);
    const book = updateBook(deps.db, id, parsed.data);
    if (!book) return context.json({ error: 'book not found' }, 404);
    return context.json({ book });
  });

  router.delete('/api/books/:id', (context: Context) => {
    const id = positiveId(context.req.param('id'));
    if (id === null) return context.json({ error: 'invalid book id' }, 400);
    const ok = deleteBook(deps.db, id);
    return ok ? context.json({ ok: true }) : context.json({ error: 'book not found' }, 404);
  });

  /** 書誌検索 — 登録フォームの補完用。 タイトルと著者を分けて投げる。 */
  router.post('/api/books/lookup', async (context: Context) => {
    const parsed = searchSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: '検索語を1〜200文字で入力してください' }, 400);
    return context.json(await lookupBibliography(getBooksConfig(deps.db), {
      title: parsed.data.query,
      author: parsed.data.author,
    }));
  });

  // ── 新刊 ──────────────────────────────────────────────────────
  router.get('/api/books/new-releases', (context: Context) => context.json({
    newReleases: listNewReleases(deps.db, { limit: 100 }),
    watchTargets: deriveWatchTargets(deps.db, getBooksConfig(deps.db)),
  }));

  router.post('/api/books/new-releases/check', async (context: Context) => {
    const db = deps.db;
    const request = booksJobCoordinator.request('new_release', () => checkNewReleases(db, getBooksConfig(db)));
    if (request.status === 'busy') return context.json({ error: '新刊チェックが実行中です' }, 409);
    return context.json({ result: await request.promise });
  });

  router.post('/api/books/new-releases/:id/dismiss', (context: Context) => {
    const id = positiveId(context.req.param('id'));
    if (id === null) return context.json({ error: 'invalid release id' }, 400);
    const ok = dismissNewRelease(deps.db, id);
    return ok ? context.json({ ok: true }) : context.json({ error: 'not found' }, 404);
  });

  // ── サジェスト ────────────────────────────────────────────────
  router.get('/api/books/suggestions', (context: Context) => context.json({
    suggestions: listSuggestions(deps.db),
  }));

  router.post('/api/books/suggestions/refresh', async (context: Context) => {
    const db = deps.db;
    const request = booksJobCoordinator.request('suggest', () => generateSuggestions(db, getBooksConfig(db)));
    if (request.status === 'busy') return context.json({ error: 'サジェスト生成が実行中です' }, 409);
    return context.json({ result: await request.promise });
  });

  router.post('/api/books/suggestions/:id/dismiss', (context: Context) => {
    const id = positiveId(context.req.param('id'));
    if (id === null) return context.json({ error: 'invalid suggestion id' }, 400);
    const ok = dismissSuggestion(deps.db, id);
    return ok ? context.json({ ok: true }) : context.json({ error: 'not found' }, 404);
  });

  /** 週次ジョブ (新刊 + サジェスト) の手動実行。 */
  router.post('/api/books/run-weekly', async (context: Context) => {
    const db = deps.db;
    const request = booksJobCoordinator.request('new_release', () => runWeeklyBooksJob(db));
    if (request.status === 'busy') return context.json({ error: '巡回が実行中です' }, 409);
    return context.json({ result: await request.promise });
  });

  // ── 読破記録インポート ────────────────────────────────────────
  router.get('/api/books/import/state', (context: Context) => context.json({
    state: getBooksImportState(deps.db),
  }));

  router.post('/api/books/import', async (context: Context) => {
    const parsed = importSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: 'invalid import payload', issues: parsed.error.issues }, 400);
    return context.json({ result: importReadingRecords(deps.db, parsed.data.text, parsed.data.format) });
  });

  // ── 設定 ──────────────────────────────────────────────────────
  router.get('/api/books/config', (context: Context) => context.json(maskRakutenId(getBooksConfig(deps.db))));

  router.put('/api/books/config', async (context: Context) => {
    const parsed = booksConfigSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: 'invalid books config', issues: parsed.error.issues }, 400);
    const merged = mergeRakutenId(getBooksConfig(deps.db), parsed.data);
    return context.json(maskRakutenId(setBooksConfig(deps.db, merged)));
  });

  return router;
}
