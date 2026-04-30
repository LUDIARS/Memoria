// Memoria Hub — multi-server entry point.
//
// Phase 2 MVP. Hono on Node, Postgres-backed, Cernere SSO + JWT.
//
// Endpoints:
//   GET  /healthz
//   GET  /api/auth/start            — kick off Cernere OAuth (PKCE)
//   GET  /api/auth/callback         — exchange code, mint JWT, redirect back
//   GET  /api/me                    — verify JWT, return user/role
//   GET  /api/shared/bookmarks
//   POST /api/shared/bookmarks
//   DELETE /api/shared/bookmarks/:id
//   GET  /api/shared/digs
//   POST /api/shared/digs
//   DELETE /api/shared/digs/:id
//   GET  /api/shared/dictionary
//   POST /api/shared/dictionary
//   DELETE /api/shared/dictionary/:id
//
// CORS is restricted to MEMORIA_HUB_ALLOWED_ORIGINS (comma-separated).

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import {
  buildAuthorizeUrl, makePkce, exchangeCode, fetchCernereUser,
  mintHubJwt, verifyHubJwt,
  cookieNames, setShortCookie, clearCookie,
} from './auth.js';
import {
  listSharedBookmarks, insertSharedBookmark, deleteSharedBookmark,
  listSharedDigs, insertSharedDig, deleteSharedDig,
  listSharedDictionary, insertSharedDictionary, deleteSharedDictionary,
  getSharedBookmark, getSharedDig, getSharedDictionary,
  recordShareEvent,
} from './db.js';

const PORT = Number(process.env.MEMORIA_HUB_PORT ?? 5280);
const ALLOWED = (process.env.MEMORIA_HUB_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const app = new Hono();

if (ALLOWED.length > 0) {
  app.use('/api/*', cors({ origin: ALLOWED, credentials: true }));
} else {
  // No allow-list configured — refuse cross-origin entirely so misconfig
  // doesn't accidentally open the API.
  app.use('/api/*', cors({ origin: () => '', credentials: false }));
}

app.get('/healthz', (c) => c.text('ok'));

// ── auth ───────────────────────────────────────────────────────────────────

app.get('/api/auth/start', (c) => {
  const redirect = c.req.query('redirect_uri') || '';
  const state = crypto.randomUUID();
  const { verifier, challenge } = makePkce();
  const url = buildAuthorizeUrl({ challenge, state });
  return new Response(null, {
    status: 302,
    headers: {
      'Location': url,
      'Set-Cookie': [
        setShortCookie(cookieNames.pkce, JSON.stringify({ verifier, state })),
        setShortCookie(cookieNames.redirect, redirect),
      ].join(', '),
    },
  });
});

function readCookie(req, name) {
  const cookieHeader = req.header('cookie') || '';
  for (const pair of cookieHeader.split(/;\s*/)) {
    const [k, v] = pair.split('=');
    if (k === name) return decodeURIComponent(v || '');
  }
  return null;
}

app.get('/api/auth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const cookieRaw = readCookie(c.req, cookieNames.pkce);
  if (!code || !state || !cookieRaw) {
    return c.json({ error: 'invalid_callback' }, 400);
  }
  let pkce;
  try { pkce = JSON.parse(cookieRaw); } catch { return c.json({ error: 'invalid_pkce_cookie' }, 400); }
  if (pkce.state !== state) return c.json({ error: 'state_mismatch' }, 400);

  const tok = await exchangeCode({ code, verifier: pkce.verifier });
  const user = await fetchCernereUser(tok.access_token);
  if (!user?.id) return c.json({ error: 'cernere_user_unavailable' }, 502);

  const jwt = await mintHubJwt({
    userId: String(user.id),
    displayName: user.display_name || user.username || String(user.id),
    role: user.role || 'user',
  });

  const redirect = readCookie(c.req, cookieNames.redirect) || '/';
  const url = new URL(redirect, redirect.startsWith('http') ? undefined : 'http://placeholder/');
  url.searchParams.set('memoria_hub_jwt', jwt);
  const finalLocation = redirect.startsWith('http') ? url.toString() : `${url.pathname}${url.search}`;

  return new Response(null, {
    status: 302,
    headers: {
      'Location': finalLocation,
      'Set-Cookie': [
        clearCookie(cookieNames.pkce),
        clearCookie(cookieNames.redirect),
      ].join(', '),
    },
  });
});

async function authedUser(c) {
  const h = c.req.header('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try { return await verifyHubJwt(m[1]); } catch { return null; }
}

app.get('/api/me', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  return c.json(u);
});

// ── /api/shared/bookmarks ──────────────────────────────────────────────────

app.get('/api/shared/bookmarks', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') || 50), 200);
  const before = c.req.query('before') || null;
  const items = await listSharedBookmarks({ limit, before });
  return c.json({ items });
});

app.post('/api/shared/bookmarks', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body?.url || !body?.title) return c.json({ error: 'url+title required' }, 400);
  const r = await insertSharedBookmark({
    url: body.url,
    title: body.title,
    summary: body.summary,
    memo: body.memo,
    categories: body.categories,
    ownerUserId: u.userId,
    ownerUserName: u.displayName,
    sharedOrigin: c.req.header('x-memoria-origin') || null,
  });
  await recordShareEvent({
    kind: 'bookmark', id: r.id, action: 'share',
    actingUserId: u.userId, details: { url: body.url },
  });
  return c.json(r, 201);
});

app.get('/api/shared/bookmarks/:id', async (c) => {
  const r = await getSharedBookmark(Number(c.req.param('id')));
  if (!r) return c.json({ error: 'not_found' }, 404);
  return c.json(r);
});

app.delete('/api/shared/bookmarks/:id', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const id = Number(c.req.param('id'));
  const r = await deleteSharedBookmark(id, { actingUserId: u.userId, role: u.role });
  if (!r.ok) return c.json({ error: r.error }, r.error === 'not_found' ? 404 : 403);
  return c.json({ ok: true });
});

// ── /api/shared/digs ───────────────────────────────────────────────────────

app.get('/api/shared/digs', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') || 50), 200);
  const before = c.req.query('before') || null;
  const items = await listSharedDigs({ limit, before });
  return c.json({ items });
});

app.post('/api/shared/digs', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body?.query) return c.json({ error: 'query required' }, 400);
  const r = await insertSharedDig({
    query: body.query,
    status: body.status || 'done',
    result: body.result,
    ownerUserId: u.userId,
    ownerUserName: u.displayName,
    sharedOrigin: c.req.header('x-memoria-origin') || null,
  });
  await recordShareEvent({
    kind: 'dig', id: r.id, action: 'share',
    actingUserId: u.userId, details: { query: body.query },
  });
  return c.json(r, 201);
});

app.get('/api/shared/digs/:id', async (c) => {
  const r = await getSharedDig(Number(c.req.param('id')));
  if (!r) return c.json({ error: 'not_found' }, 404);
  return c.json(r);
});

app.delete('/api/shared/digs/:id', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const id = Number(c.req.param('id'));
  const r = await deleteSharedDig(id, { actingUserId: u.userId, role: u.role });
  if (!r.ok) return c.json({ error: r.error }, r.error === 'not_found' ? 404 : 403);
  return c.json({ ok: true });
});

// ── /api/shared/dictionary ─────────────────────────────────────────────────

app.get('/api/shared/dictionary', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') || 100), 500);
  const q = c.req.query('q') || null;
  const items = await listSharedDictionary({ limit, q });
  return c.json({ items });
});

app.post('/api/shared/dictionary', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body?.term) return c.json({ error: 'term required' }, 400);
  const r = await insertSharedDictionary({
    term: body.term,
    definition: body.definition,
    notes: body.notes,
    ownerUserId: u.userId,
    ownerUserName: u.displayName,
    sharedOrigin: c.req.header('x-memoria-origin') || null,
  });
  await recordShareEvent({
    kind: 'dict', id: r.id, action: 'share',
    actingUserId: u.userId, details: { term: body.term },
  });
  return c.json(r, 201);
});

app.get('/api/shared/dictionary/:id', async (c) => {
  const r = await getSharedDictionary(Number(c.req.param('id')));
  if (!r) return c.json({ error: 'not_found' }, 404);
  return c.json(r);
});

app.delete('/api/shared/dictionary/:id', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const id = Number(c.req.param('id'));
  const r = await deleteSharedDictionary(id, { actingUserId: u.userId, role: u.role });
  if (!r.ok) return c.json({ error: r.error }, r.error === 'not_found' ? 404 : 403);
  return c.json({ ok: true });
});

// ── boot ───────────────────────────────────────────────────────────────────

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Memoria Hub (multi) listening on http://localhost:${info.port}`);
  console.log(`  cernere: ${process.env.MEMORIA_CERNERE_BASE || '(unset)'}`);
  console.log(`  pg: ${process.env.MEMORIA_PG_URL ? '(configured)' : '(unset)'}`);
});
