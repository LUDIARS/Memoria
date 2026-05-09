// Memoria Hub — multi-server entry point (rev3 — service-adapter 準拠)
//
// Phase 2 MVP. Hono on Node, Postgres-backed, Cernere service-adapter で
// admission を受け、 service_token を発行 + ローカル検証する。
//
// Endpoints:
//   GET    /healthz
//   GET    /api/shared/bookmarks
//   POST   /api/shared/bookmarks               (auth)
//   DELETE /api/shared/bookmarks/:id           (auth)
//   GET    /api/shared/digs
//   POST   /api/shared/digs                    (auth)
//   DELETE /api/shared/digs/:id                (auth)
//   GET    /api/shared/dictionary
//   POST   /api/shared/dictionary              (auth)
//   DELETE /api/shared/dictionary/:id          (auth)
//   ... (implementation_notes, work_locations, workplace-presence,
//        moderation/hide も同様、 詳細は server/multi/README.md)
//
// 認証フロー:
//   1. Cernere の auth UI (separate origin) でユーザがログイン
//   2. ユーザは「memoria-hub にアクセスを許可」 を Cernere 側で承認
//   3. Cernere が user_admission を /ws/service 経由で Hub に push
//   4. Hub の cernere-bridge がそれを受け取り、 service_token (HS256) を mint
//      → Cernere に admission_response で返送
//   5. Cernere が service_token を SPA / クライアントに返す
//   6. クライアントは Authorization: Bearer <service_token> で /api/shared/* を
//      叩く。 middleware が **ローカルで** HMAC 検証 (Cernere 介在なし)
//
// 旧 OAuth Authorization Code + PKCE / password grant 経路は撤去。
//
// CORS is restricted to MEMORIA_HUB_ALLOWED_ORIGINS (comma-separated).

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { createServiceAuthMiddleware } from '@ludiars/cernere-service-adapter';
import { initCernereBridge, getAdapter } from './cernere-bridge.js';
import {
  listSharedBookmarks, insertSharedBookmark, deleteSharedBookmark,
  listSharedDigs, insertSharedDig, deleteSharedDig,
  listSharedDictionary, insertSharedDictionary, deleteSharedDictionary,
  listSharedImplementationNotes, insertSharedImplementationNote, deleteSharedImplementationNote,
  listSharedWorkLocations, insertSharedWorkLocation, deleteSharedWorkLocation,
  getSharedBookmark, getSharedDig, getSharedDictionary,
  getSharedImplementationNote, getSharedWorkLocation,
  insertWorkplacePresence, listRecentWorkplacePresence, listCurrentWorkplacePresence,
  hideShared, unhideShared, listHidden, listShareLog,
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

// ── Cernere bridge: /ws/service に常時接続 + admission 受信 ──────────────

initCernereBridge();
const adapter = getAdapter();

// authMiddleware は service_token (HS256) をローカルで HMAC 検証する。
// adapter が未初期化 (CERNERE_* 未設定) のときは「全 /api/shared/* が
// 401 を返す」 状態になる — これは設計上意図的 (Cernere 連携無しでは
// シェアコンテンツの insert/delete を許さない)。
//
// 注: adapter が null でも middleware ファクトリは動くよう、 ダミー adapter
// (isRevoked: false 固定) を渡しておく。
const authedAdapter = adapter ?? { isRevoked: () => false, connected: false };
const authMiddleware = createServiceAuthMiddleware({
  adapter: authedAdapter,
  jwtSecret: process.env.SERVICE_JWT_SECRET ?? 'dev-only-jwt-secret',
  isDev: process.env.NODE_ENV !== 'production',
});

// authedUser は middleware 通過後に c.get('userId') 等から組み立てる。
function authedUser(c) {
  const userId = c.get('userId');
  if (!userId) return null;
  return {
    userId,
    displayName: c.get('userName') ?? null,
    role: c.get('userRole') ?? 'user',
  };
}

app.get('/api/me', authMiddleware, (c) => {
  const u = authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  return c.json(u);
});

// ── /api/shared/* に認証ガードを適用 ───────────────────────────────────────
//
// GET /api/shared/<kind> と GET /api/shared/<kind>/:id は **public** (誰でも
// 一覧 / 詳細を読める)。 それ以外 (POST / DELETE / モデレーション / presence) は
// service_token 必須。

const PUBLIC_GET_PATTERNS = [
  /^\/api\/shared\/bookmarks(\/\d+)?$/,
  /^\/api\/shared\/digs(\/\d+)?$/,
  /^\/api\/shared\/dictionary(\/\d+)?$/,
  /^\/api\/shared\/implementation-notes(\/\d+)?$/,
  /^\/api\/shared\/work-locations(\/\d+)?$/,
];

app.use('/api/shared/*', async (c, next) => {
  if (c.req.method === 'GET' && PUBLIC_GET_PATTERNS.some((re) => re.test(c.req.path))) {
    return next();
  }
  return authMiddleware(c, next);
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

// ── /api/shared/implementation-notes ───────────────────────────────────────

app.get('/api/shared/implementation-notes', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') || 50), 200);
  const before = c.req.query('before') || null;
  const items = await listSharedImplementationNotes({ limit, before });
  return c.json({ items });
});

app.post('/api/shared/implementation-notes', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body?.product || !body?.title) return c.json({ error: 'product+title required' }, 400);
  const r = await insertSharedImplementationNote({
    product: body.product,
    title: body.title,
    goodPoints: body.good_points,
    badPoints: body.bad_points,
    attachmentType: body.attachment_type,
    attachmentValue: body.attachment_value,
    ownerUserId: u.userId,
    ownerUserName: u.displayName,
    sharedOrigin: c.req.header('x-memoria-origin') || null,
  });
  await recordShareEvent({
    kind: 'implementation_note', id: r.id, action: 'share',
    actingUserId: u.userId, details: { product: body.product, title: body.title },
  });
  return c.json(r, 201);
});

app.get('/api/shared/implementation-notes/:id', async (c) => {
  const r = await getSharedImplementationNote(Number(c.req.param('id')));
  if (!r) return c.json({ error: 'not_found' }, 404);
  return c.json(r);
});

app.delete('/api/shared/implementation-notes/:id', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const id = Number(c.req.param('id'));
  const r = await deleteSharedImplementationNote(id, { actingUserId: u.userId, role: u.role });
  if (!r.ok) return c.json({ error: r.error }, r.error === 'not_found' ? 404 : 403);
  return c.json({ ok: true });
});

// ── /api/shared/work-locations ─────────────────────────────────────────────

app.get('/api/shared/work-locations', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') || 100), 500);
  const before = c.req.query('before') || null;
  const items = await listSharedWorkLocations({ limit, before });
  return c.json({ items });
});

app.post('/api/shared/work-locations', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body?.name) return c.json({ error: 'name required' }, 400);
  const r = await insertSharedWorkLocation({
    name: body.name,
    address: body.address,
    latitude: body.latitude == null ? null : Number(body.latitude),
    longitude: body.longitude == null ? null : Number(body.longitude),
    description: body.description,
    url: body.url,
    tags: body.tags,
    ownerUserId: u.userId,
    ownerUserName: u.displayName,
    sharedOrigin: c.req.header('x-memoria-origin') || null,
  });
  await recordShareEvent({
    kind: 'work_location', id: r.id, action: 'share',
    actingUserId: u.userId, details: { name: body.name },
  });
  return c.json(r, 201);
});

app.get('/api/shared/work-locations/:id', async (c) => {
  const r = await getSharedWorkLocation(Number(c.req.param('id')));
  if (!r) return c.json({ error: 'not_found' }, 404);
  return c.json(r);
});

app.delete('/api/shared/work-locations/:id', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const id = Number(c.req.param('id'));
  const r = await deleteSharedWorkLocation(id, { actingUserId: u.userId, role: u.role });
  if (!r.ok) return c.json({ error: r.error }, r.error === 'not_found' ? 404 : 403);
  return c.json({ ok: true });
});

// ── /api/shared/workplace-presence ─────────────────────────────────────────
//
// Ephemeral "I am at <place>" stream for the team. POST when a user enters
// or leaves a workplace; GET to see the current state of the team.

app.post('/api/shared/workplace-presence', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body?.workplace_name) return c.json({ error: 'workplace_name required' }, 400);
  const r = await insertWorkplacePresence({
    userId: u.userId,
    userName: u.displayName,
    workplaceName: body.workplace_name,
    address: body.address ?? null,
    latitude: body.latitude == null ? null : Number(body.latitude),
    longitude: body.longitude == null ? null : Number(body.longitude),
    kind: body.kind === 'leave' ? 'leave' : 'enter',
    sharedOrigin: c.req.header('x-memoria-origin') || null,
  });
  await recordShareEvent({
    kind: 'workplace_presence', id: r.id, action: 'share',
    actingUserId: u.userId, details: { workplace_name: body.workplace_name, kind: body.kind || 'enter' },
  });
  return c.json(r, 201);
});

app.get('/api/shared/workplace-presence', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const limit = Math.min(Number(c.req.query('limit') || 50), 500);
  const sinceHours = Math.min(Number(c.req.query('since_hours') || 24), 24 * 30);
  const items = await listRecentWorkplacePresence({ limit, sinceHours });
  return c.json({ items });
});

app.get('/api/shared/workplace-presence/current', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const limit = Math.min(Number(c.req.query('limit') || 100), 500);
  const items = await listCurrentWorkplacePresence({ limit });
  return c.json({ items });
});

// ── /api/shared/moderation/* (admin / moderator only) ──────────────────────
//
// Hide soft-removes a row from public listings; unhide reverses it. The row
// stays in the table either way so the audit trail is not lost.
function isModerator(u) { return u.role === 'admin' || u.role === 'moderator'; }

app.post('/api/shared/moderation/hide', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  if (!isModerator(u)) return c.json({ error: 'forbidden' }, 403);
  const body = await c.req.json().catch(() => null);
  if (!body?.kind || body.id == null) return c.json({ error: 'kind+id required' }, 400);
  const r = await hideShared(body.kind, Number(body.id), {
    actingUserId: u.userId, reason: body.reason,
  });
  if (!r.ok) return c.json({ error: r.error }, 400);
  return c.json({ ok: true });
});

app.post('/api/shared/moderation/unhide', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  if (!isModerator(u)) return c.json({ error: 'forbidden' }, 403);
  const body = await c.req.json().catch(() => null);
  if (!body?.kind || body.id == null) return c.json({ error: 'kind+id required' }, 400);
  const r = await unhideShared(body.kind, Number(body.id), { actingUserId: u.userId });
  if (!r.ok) return c.json({ error: r.error }, 400);
  return c.json({ ok: true });
});

app.get('/api/shared/moderation/hidden', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  if (!isModerator(u)) return c.json({ error: 'forbidden' }, 403);
  const limit = Math.min(Number(c.req.query('limit') || 100), 500);
  const items = await listHidden({ limit });
  return c.json({ items });
});

app.get('/api/shared/moderation/log', async (c) => {
  const u = await authedUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  if (!isModerator(u)) return c.json({ error: 'forbidden' }, 403);
  const limit = Math.min(Number(c.req.query('limit') || 200), 1000);
  const items = await listShareLog({ limit });
  return c.json({ items });
});

// ── boot ───────────────────────────────────────────────────────────────────

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Memoria Hub (multi) listening on http://localhost:${info.port}`);
  console.log(`  cernere ws: ${process.env.CERNERE_WS_URL || '(unset)'}`);
  console.log(`  service_code: ${process.env.CERNERE_SERVICE_CODE || 'memoria-hub'}`);
  console.log(`  cernere bridge: ${adapter ? 'connecting' : 'skip (creds missing)'}`);
  console.log(`  pg: ${process.env.MEMORIA_PG_URL ? '(configured)' : '(unset)'}`);
});
