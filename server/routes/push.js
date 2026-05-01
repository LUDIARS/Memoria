// WebPush router (mounted at `/api/push`).
//
// VAPID 鍵公開 (フロントの PushManager.subscribe 用) と、 端末ごとの
// subscription 登録 / 解除 / テスト送信。 シングルユーザ前提なので
// projectKey や userId は持たない。
import { Hono } from 'hono';

export function createPushRouter({
  db,
  getVapidPublicKey,
  saveSubscription,
  sendPushToAll,
  listPushSubscriptions,
  deletePushSubscription,
}) {
  const router = new Hono();

  router.get('/vapid-public-key', (c) => {
    const key = getVapidPublicKey();
    if (!key) return c.json({ error: 'VAPID not configured' }, 503);
    return c.json({ publicKey: key });
  });

  router.post('/subscribe', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
      return c.json({ error: 'subscription with keys.p256dh and keys.auth required' }, 400);
    }
    const id = saveSubscription(db, {
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      label: body.label ?? null,
      userAgent: body.userAgent ?? c.req.header('user-agent') ?? null,
    });
    return c.json({ id, ok: true });
  });

  router.get('/subscriptions', (c) => {
    return c.json({ items: listPushSubscriptions(db) });
  });

  router.delete('/subscriptions/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const removed = deletePushSubscription(db, id);
    if (!removed) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  router.post('/test', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await sendPushToAll(db, {
      title: body?.title ?? 'Memoria テスト通知',
      body: body?.body ?? '通知が届けば設定 OK です。',
      url: body?.url ?? '/',
      icon: '/icon-192.svg',
      tag: 'memoria-test',
    });
    return c.json(result);
  });

  return router;
}
