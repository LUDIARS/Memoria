// /api/ai/* — 🤖 AI ハブ (記事 / 記事ネタ / AIアドバイス)。
// Spec: spec/feature/ai-hub.md §API

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  listAiArticles, getAiArticle, setAiArticleNote,
  listAiArticleTags, listDiaryDigestCandidates,
  setAiArticleTags, listAiArticlesMissingLlmTags, setAiArticleBody, countAiArticles,
  listAiSeeds, getAiSeed, updateAiSeedStatus,
  latestAiAdvice,
  insertNote, insertBlock, getNote,
} from '../db.js';
import { runDigest, requestSeed, runAdvice, generateArticleTags, repairArticleBody, articleToMarkdown } from '../ai-hub/index.js';
import type { ArticleTag } from '../ai-hub/types.js';
import { yesterdayLocal, formatLocalDate } from '../diary.js';
import {
  readMode, readMultiServers, findServerByUrl, hubFetch, type HubResponse,
} from '../local/multi-client.js';
import { scanForbiddenTerms, type RedactionFinding } from '../shared/redaction.js';

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

interface ShareRequestBody {
  hubUrl?: unknown;
  includeSourceRefs?: unknown;
}

interface ShareCheckBody {
  ids?: unknown;
}

function redactionTerms(db: Db): string[] {
  return (db.prepare('SELECT term FROM achievement_redaction_terms').all() as { term: string }[])
    .map((row) => row.term);
}

function articleFields(article: NonNullable<ReturnType<typeof getAiArticle>>): Record<string, string> {
  return {
    title: article.title,
    body_md: article.body_md,
    tags: JSON.stringify(article.tags),
    source_refs: JSON.stringify(article.source_refs),
    ...(article.topic_key ? { topic_key: article.topic_key } : {}),
  };
}

function articleFindings(db: Db, article: NonNullable<ReturnType<typeof getAiArticle>>): RedactionFinding[] {
  return scanForbiddenTerms(articleFields(article), redactionTerms(db));
}

function sourceRefRepos(article: NonNullable<ReturnType<typeof getAiArticle>>): string[] {
  return [...new Set(article.source_refs
    .map((source) => source.repo?.trim())
    .filter((repo): repo is string => Boolean(repo)))];
}

/**
 * `プロジェクト` タグは source_refs の repo 名から決定論的に補われる。
 * source_refs を出さない共有で一緒に送ると、既定 redacted policy を迂回して
 * private repo 名を漏らすので落とす。
 */
function shareableTags(
  article: NonNullable<ReturnType<typeof getAiArticle>>,
  includeSourceRefs: boolean,
  repos: readonly string[],
): ArticleTag[] {
  return article.tags.filter((tag) => (
    tag.category !== 'プロジェクト' || (includeSourceRefs && repos.includes(tag.value))
  ));
}

/** `repo:theme` の topic_key は、明示許可済み source_refs の repo に限り共有する。 */
function shareableTopicKey(topicKey: string | null, repos: readonly string[]): string | null {
  if (!topicKey) return null;
  const separator = topicKey.indexOf(':');
  if (separator <= 0 || !repos.includes(topicKey.slice(0, separator))) return null;
  return topicKey;
}

function sourceRefsAreShareable(db: Db, repos: readonly string[]): boolean {
  if (repos.length === 0) return true;
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'achievement_sources'")
    .get();
  if (!table) return false;

  const statement = db.prepare('SELECT share_policy FROM achievement_sources WHERE repo_key = ?');
  return repos.every((repo) => {
    const row = statement.get(repo) as { share_policy: string } | undefined;
    return row?.share_policy === 'full';
  });
}

interface HubSession {
  hubUrl: string;
  sessionToken: string;
  userId: string;
}

interface RemoteArticleRow {
  id: number;
  origin_local_id: number;
  owner_user_id: string;
}

const HUB_PAGE_SIZE = 200;
// offset を無視して同じページを返し続ける Hub に当たっても、 ローカル側が
// 無限ループしないよう上限を切る。 打ち切りは 502 で可視化する (無言で
// 「共有されていない」 と答えると、 実際は Hub に残っている行を取り下げ済みと
// 誤って報告することになる)。
const HUB_MAX_PAGES = 50;

/**
 * Hub 上の自分の共有行を origin_local_id で引く。 見つからなければ null。
 * list API は 1 回 200 件が上限なので、 尽きるまでページを送る。
 */
async function findRemoteArticle(
  session: HubSession,
  originLocalId: number,
): Promise<RemoteArticleRow | null> {
  for (let page = 0; page < HUB_MAX_PAGES; page += 1) {
    const response = await hubFetch(
      session.hubUrl,
      session.sessionToken,
      `/api/data/ai-articles?limit=${HUB_PAGE_SIZE}&offset=${page * HUB_PAGE_SIZE}`,
      { redirect: 'error' },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new HubRequestError(response.status, response.body, response.contentType);
    }
    const items = (response.body as { items?: RemoteArticleRow[] }).items ?? [];
    const hit = items.find(
      (item) => item.origin_local_id === originLocalId && item.owner_user_id === session.userId,
    );
    if (hit) return hit;
    if (items.length < HUB_PAGE_SIZE) return null;
  }
  throw new HubRequestError(502, { error: 'hub_lookup_exhausted' });
}

/**
 * Hub のレスポンスをそのまま中継する。 Hono の `c.json(body, status)` は
 * status を literal union で受けるので、 動的な status は multi-proxy と同じく
 * 素の Response で返す。 Content-Type も Hub のものを引き継ぐ (JSON でない
 * エラー本文を application/json と偽ると、 呼び出し側の res.json() が壊れる)。
 */
function relayHubResponse(status: number, body: unknown, contentType = 'application/json'): Response {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(payload, { status, headers: { 'Content-Type': contentType } });
}

class HubRequestError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
    readonly contentType = 'application/json',
  ) {
    super(`hub request failed with ${status}`);
    this.name = 'HubRequestError';
  }
}

/** Hub への到達失敗 (DNS / TLS / 接続断) を 502 に畳む。 multi-proxy と同じ扱い。 */
function hubUnreachable(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ error: 'hub_unreachable', detail: message }, 502);
}

function resolveHubSession(db: Db, requestedHubUrl: unknown): HubSession | null {
  const configuredHubUrl = readMode(db).hubUrl;
  const hubUrl = typeof requestedHubUrl === 'string'
    ? requestedHubUrl.trim().replace(/\/$/, '')
    : configuredHubUrl;
  if (!hubUrl) return null;

  const server = findServerByUrl(readMultiServers(db).servers, hubUrl);
  if (!server?.jwt || !server.userId) return null;
  return { hubUrl, sessionToken: server.jwt, userId: server.userId };
}

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

  // フィルタ chips / サジェスト用: 全記事のタグを category+value で集計 + 記事総数。
  r.get('/api/ai/tags', (c: Context) => {
    return c.json({ tags: listAiArticleTags(db), total: countAiArticles(db) });
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

  // 記事を Markdown ファイル (.md) として書き出す (frontmatter + 本文 + 出所)。
  // ブラウザにダウンロードさせるため Content-Disposition: attachment を付ける。
  // 日本語ファイル名は RFC 5987 (filename*) で渡し、 ascii fallback も併記する。
  r.get('/api/ai/articles/:id/export.md', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const article = getAiArticle(db, id);
    if (!article) return c.json({ error: 'not found' }, 404);
    const { filename, content } = articleToMarkdown(article);
    const asciiFallback = `ai-article-${article.id}.md`;
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    c.header(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    return c.body(content);
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

  // ── Hub 共有 (禁止語ゲート) ───────────────────────────────────────────────
  // Spec: spec/interface/hub-social.md §6.5 / spec/data/hub-social.md §4.5

  r.post('/api/ai/articles/share/check', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as ShareCheckBody;
    // ids 省略時は直近 500 件だけを見る (listAiArticles の上限)。 全件保証ではない。
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
      : listAiArticles(db, { limit: 500 }).map((article) => article.id);
    const blocked = ids.flatMap((articleId) => {
      const article = getAiArticle(db, articleId);
      if (!article) return [];
      return articleFindings(db, article).map((finding) => ({ articleId, ...finding }));
    });
    return c.json({ ok: blocked.length === 0, blocked });
  });

  r.post('/api/ai/articles/:id/share', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const article = getAiArticle(db, id);
    if (!article) return c.json({ error: 'not found' }, 404);

    const body = await c.req.json().catch(() => ({})) as ShareRequestBody;
    const blocked = articleFindings(db, article);
    if (blocked.length > 0) return c.json({ error: 'redaction_blocked', blocked }, 409);

    const includeSourceRefs = body.includeSourceRefs === true;
    const repos = sourceRefRepos(article);
    if (includeSourceRefs && !sourceRefsAreShareable(db, repos)) {
      return c.json({ error: 'source_refs_not_shareable', repos }, 400);
    }

    const session = resolveHubSession(db, body.hubUrl);
    if (!session) return c.json({ error: 'no_hub' }, 503);

    let response: HubResponse;
    try {
      response = await hubFetch(session.hubUrl, session.sessionToken, '/api/data/ai-articles', {
        method: 'POST',
        // Bearer token を別 origin への redirect に追従させない。
        redirect: 'error',
        body: JSON.stringify({
          origin_local_id: article.id,
          title: article.title,
          body_md: article.body_md,
          for_date: article.for_date,
          tags_json: shareableTags(article, includeSourceRefs, repos),
          source_refs_json: includeSourceRefs ? article.source_refs : null,
          // topic_key は `repo:theme` 形式で repo 名を含む (spec/data/hub-social.md §4.5)
          // ので、 source_refs と同じ条件でしか出さない。
          topic_key: includeSourceRefs ? shareableTopicKey(article.topic_key, repos) : null,
          // 監査列。 source_refs を落としたなら redacted、 全部出したなら full。
          // 「常に full」 と記録すると、 後から「何を出したか」 を追えなくなる。
          share_policy: includeSourceRefs ? 'full' : 'redacted',
          redaction_scanned_at: new Date().toISOString(),
        }),
      });
    } catch (error) {
      return hubUnreachable(c, error);
    }
    if (response.status < 200 || response.status >= 300) {
      return relayHubResponse(response.status, response.body, response.contentType);
    }

    // Hub の POST /api/data/:type は作成した行をそのまま返す (`{ items }` で包まない)。
    const item = response.body as { id?: unknown } | null;
    return c.json({ ok: true, remoteId: item?.id ?? null });
  });

  r.post('/api/ai/articles/:id/unshare', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const article = getAiArticle(db, id);
    if (!article) return c.json({ error: 'not found' }, 404);

    const body = await c.req.json().catch(() => ({})) as ShareRequestBody;
    const session = resolveHubSession(db, body.hubUrl);
    if (!session) return c.json({ error: 'no_hub' }, 503);

    // Hub の list は 1 回 200 件が上限なので、 見つかるまで送る。 1 ページだけ見て
    // 「無い」 と判断すると、 201 件目以降にある行を取り下げ済みと誤って報告する。
    let remote: RemoteArticleRow | null;
    try {
      remote = await findRemoteArticle(session, article.id);
    } catch (error) {
      if (error instanceof HubRequestError) {
        return relayHubResponse(error.status, error.payload, error.contentType);
      }
      return hubUnreachable(c, error);
    }
    if (remote === null) return c.json({ error: 'not_shared' }, 404);

    let response: HubResponse;
    try {
      response = await hubFetch(session.hubUrl, session.sessionToken, `/api/data/ai-articles/${remote.id}`, {
        method: 'DELETE',
        redirect: 'error',
      });
    } catch (error) {
      return hubUnreachable(c, error);
    }
    if (response.status < 200 || response.status >= 300) {
      return relayHubResponse(response.status, response.body, response.contentType);
    }
    return c.json({ ok: true });
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
