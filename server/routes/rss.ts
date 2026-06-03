// /api/rss/* — RSS リーダー + トレンド取り込み + AI パーソナライズ ("自分専用 Discover")。
// Spec: spec/feature/rss.md

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  listFeeds, getFeed, getFeedByUrl, insertFeed, updateFeed, deleteFeed,
  listArticles, getArticle, setArticleRead, setArticleStar,
  listInterests, insertInterest, updateInterest, deleteInterest,
  getRssConfig, setRssConfig, resetAllScores,
  getLatestDigest,
  detectFeedKind, discoverFeeds, FEED_PRESETS,
  pollFeed, pollAllFeeds, scoreArticle, scorePendingArticles,
  summarizeArticle, generateDigest,
} from '../rss/index.js';
import type { RssFeedKind, DiscoveredFeed } from '../rss/index.js';
import { postRssNewsNow } from '../discord/index.js';

type Db = BetterSqlite3.Database;

export interface RssRouterDeps {
  db: Db;
}

function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function makeRssRouter(deps: RssRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  // ── presets / feeds ──────────────────────────────────────────────────────

  r.get('/api/rss/presets', (c: Context) => c.json({ items: FEED_PRESETS }));

  // サイト URL から登録可能な RSS/Atom フィードを発見する。
  r.post('/api/rss/discover', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as { url?: unknown } | null;
    const url = normalizeUrl(body?.url);
    if (!url) return c.json({ error: 'valid http(s) url required' }, 400);
    const found = await discoverFeeds(url);
    const items: DiscoveredFeed[] = found.map(f => ({ ...f, alreadyRegistered: !!getFeedByUrl(db, f.url) }));
    return c.json({ items });
  });

  r.get('/api/rss/feeds', (c: Context) => c.json({ items: listFeeds(db) }));

  r.post('/api/rss/feeds', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as
      | { url?: unknown; category?: unknown; kind?: unknown } | null;
    const url = normalizeUrl(body?.url);
    if (!url) return c.json({ error: 'valid http(s) url required' }, 400);
    if (getFeedByUrl(db, url)) return c.json({ error: 'already registered', duplicate: true }, 409);

    const kind: RssFeedKind = (body?.kind === 'hatena' || body?.kind === 'google_trends' || body?.kind === 'rss')
      ? body.kind
      : detectFeedKind(url);
    const category = typeof body?.category === 'string' && body.category.trim()
      ? body.category.trim().slice(0, 40)
      : null;
    const id = insertFeed(db, { url, kind, category });
    // 初回取得は非同期で即キック (登録レスポンスは待たせない)。
    void pollFeed(db, id)
      .then(async () => { await scorePendingArticles(db).catch(() => {}); })
      .catch((e: unknown) => console.error('[rss] initial poll failed:', e instanceof Error ? e.message : String(e)));
    return c.json({ id, url, kind, category, queued: true });
  });

  r.patch('/api/rss/feeds/:id', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id) || !getFeed(db, id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => null) as
      | { enabled?: unknown; category?: unknown; title?: unknown } | null;
    updateFeed(db, id, {
      enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
      category: typeof body?.category === 'string' ? body.category.slice(0, 40) : undefined,
      title: typeof body?.title === 'string' ? body.title.slice(0, 200) : undefined,
    });
    return c.json({ ok: true, feed: getFeed(db, id) });
  });

  r.delete('/api/rss/feeds/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    return deleteFeed(db, id) ? c.json({ ok: true, id }) : c.json({ error: 'not found' }, 404);
  });

  r.post('/api/rss/feeds/:id/refresh', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id) || !getFeed(db, id)) return c.json({ error: 'not found' }, 404);
    const result = await pollFeed(db, id);
    if (result.ok && result.newCount > 0 && getRssConfig(db).auto_score) {
      await scorePendingArticles(db).catch(() => {});
    }
    return c.json({ ...result, feed: getFeed(db, id) });
  });

  r.post('/api/rss/refresh', async (c: Context) => {
    const summary = await pollAllFeeds(db);
    return c.json(summary);
  });

  // ── articles ─────────────────────────────────────────────────────────────

  r.get('/api/rss/articles', (c: Context) => {
    const q = c.req.query.bind(c.req);
    const items = listArticles(db, {
      feedId: q('feed_id') ? Number(q('feed_id')) : null,
      category: q('category') || null,
      kind: (q('kind') as RssFeedKind) || null,
      minScore: q('min_score') ? Number(q('min_score')) : null,
      unreadOnly: q('unread') === '1',
      starredOnly: q('starred') === '1',
      sort: q('sort') === 'score' ? 'score' : 'published',
      limit: q('limit') ? Number(q('limit')) : 50,
      offset: q('offset') ? Number(q('offset')) : 0,
    });
    return c.json({ items });
  });

  r.post('/api/rss/articles/:id/read', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id) || !getArticle(db, id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => null) as { read?: unknown } | null;
    const read = typeof body?.read === 'boolean' ? body.read : true;
    setArticleRead(db, id, read);
    return c.json({ ok: true, id, read });
  });

  r.post('/api/rss/articles/:id/star', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id) || !getArticle(db, id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => null) as { starred?: unknown } | null;
    const cur = getArticle(db, id);
    const starred = typeof body?.starred === 'boolean' ? body.starred : !(cur && cur.starred);
    setArticleStar(db, id, starred);
    return c.json({ ok: true, id, starred });
  });

  r.post('/api/rss/articles/:id/score', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id) || !getArticle(db, id)) return c.json({ error: 'not found' }, 404);
    const score = await scoreArticle(db, id);
    return c.json({ ok: true, id, score, article: getArticle(db, id) });
  });

  r.post('/api/rss/articles/:id/summarize', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id) || !getArticle(db, id)) return c.json({ error: 'not found' }, 404);
    const summary = await summarizeArticle(db, id);
    if (!summary) return c.json({ error: '要約の生成に失敗しました' }, 502);
    return c.json({ ok: true, id, summary, article: getArticle(db, id) });
  });

  // ── おすすめダイジェスト ─────────────────────────────────────────────────

  r.get('/api/rss/digest', (c: Context) => c.json({ digest: getLatestDigest(db) ?? null }));

  r.post('/api/rss/digest', async (c: Context) => {
    const row = await generateDigest(db);
    if (!row) return c.json({ error: 'ダイジェストの素材になる記事がありません' }, 400);
    return c.json({ digest: row });
  });

  // 今日のダイジェスト + 気になるニュースを Discord #news に即時投稿。
  r.post('/api/rss/discord-post', async (c: Context) => {
    const r2 = await postRssNewsNow(db);
    if (!r2.ok) return c.json({ error: r2.reason || 'Discord に投稿できませんでした (Bot 未接続?)' }, 502);
    return c.json(r2);
  });

  // ── interests (AI Feeds テーマ) ──────────────────────────────────────────

  r.get('/api/rss/interests', (c: Context) => c.json({ items: listInterests(db) }));

  r.post('/api/rss/interests', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as
      | { label?: unknown; prompt?: unknown; weight?: unknown } | null;
    const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 80) : '';
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim().slice(0, 1000) : '';
    if (!label || !prompt) return c.json({ error: 'label and prompt required' }, 400);
    const weight = Number(body?.weight);
    const id = insertInterest(db, { label, prompt, weight: Number.isFinite(weight) ? weight : 1.0 });
    return c.json({ id, label, prompt });
  });

  r.patch('/api/rss/interests/:id', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const body = await c.req.json().catch(() => null) as
      | { label?: unknown; prompt?: unknown; weight?: unknown; enabled?: unknown } | null;
    updateInterest(db, id, {
      label: typeof body?.label === 'string' ? body.label.slice(0, 80) : undefined,
      prompt: typeof body?.prompt === 'string' ? body.prompt.slice(0, 1000) : undefined,
      weight: Number.isFinite(Number(body?.weight)) ? Number(body?.weight) : undefined,
      enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
    });
    return c.json({ ok: true, id });
  });

  r.delete('/api/rss/interests/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    return deleteInterest(db, id) ? c.json({ ok: true, id }) : c.json({ error: 'not found' }, 404);
  });

  // 興味テーマを変えた後に全記事を再採点 (非同期、 即レスポンス)。
  r.post('/api/rss/rescore', (c: Context) => {
    resetAllScores(db);
    void scorePendingArticles(db, 200).catch((e: unknown) =>
      console.error('[rss] rescore failed:', e instanceof Error ? e.message : String(e)));
    return c.json({ ok: true, queued: true });
  });

  // ── settings ─────────────────────────────────────────────────────────────

  r.get('/api/rss/settings', (c: Context) => c.json(getRssConfig(db)));

  r.patch('/api/rss/settings', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'body required' }, 400);
    setRssConfig(db, {
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      poll_interval_minutes: Number.isFinite(Number(body.poll_interval_minutes)) ? Number(body.poll_interval_minutes) : undefined,
      auto_score: typeof body.auto_score === 'boolean' ? body.auto_score : undefined,
      min_score_notify: Number.isFinite(Number(body.min_score_notify)) ? Number(body.min_score_notify) : undefined,
      notify_enabled: typeof body.notify_enabled === 'boolean' ? body.notify_enabled : undefined,
      auto_summarize: typeof body.auto_summarize === 'boolean' ? body.auto_summarize : undefined,
    });
    return c.json(getRssConfig(db));
  });

  return r;
}
