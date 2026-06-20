// /api/ai/* — 🤖 AI ハブ (記事 / 記事ネタ / AIアドバイス)。
// Spec: spec/feature/ai-hub.md §API

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  listAiArticles, getAiArticle, setAiArticleNote,
  listAiArticleTags, listDiaryDigestCandidates,
  setAiArticleTags, listAiArticlesMissingLlmTags, setAiArticleBody,
  listAiSeeds, getAiSeed, updateAiSeedStatus,
  latestAiAdvice,
  insertNote, insertBlock, getNote,
} from '../db.js';
import { runDigest, requestSeed, runAdvice, generateArticleTags, repairArticleBody } from '../ai-hub/index.js';
import type { ArticleTag } from '../ai-hub/types.js';
import { yesterdayLocal, formatLocalDate } from '../diary.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `?tag=言語:TypeScript&tag=プロジェクト:Memoria` を ArticleTag[] にパース。 */
function parseTagQuery(c: Context): ArticleTag[] {
  const raw = c.req.queries('tag') ?? [];
  const out: ArticleTag[] = [];
  for (const entry of raw) {
    const idx = entry.indexOf(':');
    if (idx <= 0) continue;
    const category = entry.slice(0, idx).trim();
    const value = entry.slice(idx + 1).trim();
    if (category && value) out.push({ category, value });
  }
  return out;
}

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
    const fromQ = c.req.query('from');
    const toQ = c.req.query('to');
    const from = fromQ && DATE_RE.test(fromQ) ? fromQ : null;
    const to = toQ && DATE_RE.test(toQ) ? toQ : null;
    const tags = parseTagQuery(c);
    return c.json({ articles: listAiArticles(db, { limit, from, to, tags }) });
  });

  // フィルタ chips 用: 全記事のタグを category+value で集計。
  r.get('/api/ai/tags', (c: Context) => {
    return c.json({ tags: listAiArticleTags(db) });
  });

  // 救済: body_md に raw JSON が入った旧記事を、内側の Markdown に直す (LLM 不要)。
  r.post('/api/ai/articles/repair-bodies', (c: Context) => {
    const articles = listAiArticles(db, { limit: 500 });
    let repaired = 0;
    for (const a of articles) {
      const fixed = repairArticleBody(a.body_md, a.title);
      if (fixed) { setAiArticleBody(db, a.id, fixed.title, fixed.body_md); repaired++; }
    }
    return c.json({ repaired, considered: articles.length });
  });

  // 再タグ付け: LLM 軸タグ (言語/内容タイプ/技術領域/その他) が欠けた記事を
  // 完成済み本文から再タグ付けする。 body.id 指定で 1 件、 無指定で欠落分一括。
  r.post('/api/ai/articles/retag', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as { id?: unknown };
    const targets = typeof body.id === 'number'
      ? [getAiArticle(db, body.id)].filter((a): a is NonNullable<typeof a> => !!a)
      : listAiArticlesMissingLlmTags(db);
    let updated = 0;
    for (const a of targets) {
      try {
        const llmTags = await generateArticleTags(a.title, a.body_md);
        if (!llmTags.length) continue;
        const project = a.tags.filter((t) => t.category === 'プロジェクト');
        const merged: ArticleTag[] = [];
        const seen = new Set<string>();
        for (const t of [...project, ...llmTags]) {
          const k = `${t.category} ${t.value}`;
          if (seen.has(k)) continue;
          seen.add(k);
          merged.push(t);
        }
        setAiArticleTags(db, a.id, merged);
        updated++;
      } catch { /* 1 件失敗で止めない */ }
    }
    return c.json({ updated, considered: targets.length });
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

  // さかのぼり生成の候補日 (日記がある日 + 既存記事件数)。 日記タブの一括生成 UI 用。
  r.get('/api/ai/digest/candidates', (c: Context) => {
    const fromQ = c.req.query('from');
    const toQ = c.req.query('to');
    if (!fromQ || !DATE_RE.test(fromQ) || !toQ || !DATE_RE.test(toQ)) {
      return c.json({ error: 'from/to (YYYY-MM-DD) required' }, 400);
    }
    return c.json({ days: listDiaryDigestCandidates(db, fromQ, toQ) });
  });

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
