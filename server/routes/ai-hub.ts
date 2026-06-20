// /api/ai/* — 🤖 AI ハブ (記事 / 記事ネタ / AIアドバイス)。
// Spec: spec/feature/ai-hub.md §API

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  listAiArticles, getAiArticle, setAiArticleNote,
  listAiSeeds, getAiSeed, updateAiSeedStatus,
  latestAiAdvice,
  insertNote, insertBlock, getNote,
} from '../db.js';
import { runDigest, requestSeed, runAdvice } from '../ai-hub/index.js';
import { yesterdayLocal, formatLocalDate } from '../diary.js';

type Db = BetterSqlite3.Database;

export interface AiHubRouterDeps {
  db: Db;
}

export function makeAiHubRouter(deps: AiHubRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  // ── 記事 ────────────────────────────────────────────────────────────────

  r.get('/api/ai/articles', (c: Context) => {
    const limit = Math.min(Number(c.req.query('limit') || 50), 500);
    return c.json({ articles: listAiArticles(db, limit) });
  });

  r.get('/api/ai/articles/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const article = getAiArticle(db, id);
    if (!article) return c.json({ error: 'not found' }, 404);
    return c.json({ article });
  });

  // 記事から note を作成し、 ai_articles.note_id を更新する。
  // body_md は 1 つの text ブロックとして note に流し込む。
  r.post('/api/ai/articles/:id/transcribe', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const article = getAiArticle(db, id);
    if (!article) return c.json({ error: 'not found' }, 404);

    const noteId = insertNote(db, {
      title: article.title || 'AI 記事',
      kind: 'doc',
      tags: ['ai-article'],
      source_kind: 'ai_article',
      source_ref: String(article.id),
    });
    insertBlock(db, noteId, { block_type: 'text', text: article.body_md });
    setAiArticleNote(db, id, noteId);

    const note = getNote(db, noteId);
    return c.json({ note }, 201);
  });

  // ── 記事ネタ (seeds) ──────────────────────────────────────────────────────

  r.get('/api/ai/seeds', (c: Context) => {
    const statusQ = c.req.query('status');
    const status = statusQ === undefined ? 'pending' : (statusQ || null);
    return c.json({ seeds: listAiSeeds(db, status) });
  });

  // seed を本記事化する → ai_articles に insert、 seed.status='done' + article_id 設定。
  r.post('/api/ai/seeds/:id/request', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const seed = getAiSeed(db, id);
    if (!seed) return c.json({ error: 'not found' }, 404);
    try {
      const article = await requestSeed(db, id);
      if (!article) return c.json({ error: 'failed to create article' }, 500);
      updateAiSeedStatus(db, id, 'done', article.id);
      return c.json({ article }, 201);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 500);
    }
  });

  r.post('/api/ai/seeds/:id/dismiss', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const seed = getAiSeed(db, id);
    if (!seed) return c.json({ error: 'not found' }, 404);
    updateAiSeedStatus(db, id, 'dismissed');
    return c.json({ ok: true });
  });

  // ── AIアドバイス ──────────────────────────────────────────────────────────

  r.get('/api/ai/advice/latest', (c: Context) => {
    return c.json({ advice: latestAiAdvice(db) });
  });

  // ── オンデマンド実行 ──────────────────────────────────────────────────────

  r.post('/api/ai/digest/run-now', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { date?: unknown };
    const date = typeof body.date === 'string' && body.date.trim() ? body.date.trim() : yesterdayLocal();
    try {
      const result = await runDigest(db, date);
      return c.json(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 500);
    }
  });

  r.post('/api/ai/advice/run-now', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { date?: unknown };
    const date = typeof body.date === 'string' && body.date.trim() ? body.date.trim() : formatLocalDate();
    try {
      const advice = await runAdvice(db, date);
      return c.json({ advice });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 500);
    }
  });

  return r;
}
