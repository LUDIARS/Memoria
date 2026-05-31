// /api/push* — WebPush API (VAPID 公開鍵 + subscription 管理 + テスト送信)。
// Spec: spec/interface/push.md

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { listPushSubscriptions, deletePushSubscription } from '../db.js';
import { getVapidPublicKey, saveSubscription, sendPushToAll } from '../push.js';

type Db = BetterSqlite3.Database;

export interface PushRouterDeps {
  db: Db;
}

export function makePushRouter(deps: PushRouterDeps): Hono {
  const { db } = deps;
  const r = new Hono();

  // ── WebPush API ────────────────────────────────────────────
  //
  // VAPID 鍵公開 (フロントの PushManager.subscribe 用) と、 端末ごとの
  // subscription 登録 / 解除 / テスト送信。 シングルユーザ前提なので
  // projectKey や userId は持たない。

  r.get('/api/push/vapid-public-key', (c: Context) => {
    const key = getVapidPublicKey();
    if (!key) return c.json({ error: 'VAPID not configured' }, 503);
    return c.json({ publicKey: key });
  });

  r.post('/api/push/subscribe', async (c: Context) => {
    const body = await c.req.json().catch(() => null) as
      | { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; label?: unknown; userAgent?: unknown }
      | null;
    if (
      !body
      || typeof body.endpoint !== 'string'
      || !body.keys
      || typeof body.keys.p256dh !== 'string'
      || typeof body.keys.auth !== 'string'
    ) {
      return c.json({ error: 'subscription with keys.p256dh and keys.auth required' }, 400);
    }
    const id = saveSubscription(db, {
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      label: typeof body.label === 'string' ? body.label : null,
      userAgent: typeof body.userAgent === 'string' ? body.userAgent : c.req.header('user-agent') ?? null,
    });
    return c.json({ id, ok: true });
  });

  r.get('/api/push/subscriptions', (c: Context) => {
    return c.json({ items: listPushSubscriptions(db) });
  });

  r.delete('/api/push/subscriptions/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const removed = deletePushSubscription(db, id);
    if (!removed) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  r.post('/api/push/test', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as
      { title?: unknown; body?: unknown; url?: unknown };
    const result = await sendPushToAll(db, {
      title: typeof body.title === 'string' ? body.title : 'Memoria テスト通知',
      body: typeof body.body === 'string' ? body.body : '通知が届けば設定 OK です。',
      url: typeof body.url === 'string' ? body.url : '/',
      icon: '/icon-192.svg',
      tag: 'memoria-test',
    });
    return c.json(result);
  });

  return r;
}
