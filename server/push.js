/**
 * WebPush 配信 — Memoria 内蔵。 Nuntius と独立したシングルユーザ向け実装。
 *
 * VAPID 鍵は env が無ければ起動時に generate し、`<dataDir>/vapid.json`
 * に永続化する (鍵を毎回再生成すると既存購読が無効になる)。
 *
 * 既存購読は `push_subscriptions` テーブルで管理。 410/404 を受けた
 * subscription は revokedAt を立てて以降の送信対象から外す。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import {
  insertPushSubscription,
  listActivePushSubscriptions,
  markPushSubscriptionRevoked,
  findPushSubscriptionByEndpoint,
} from './db.js';

let configured = false;
let publicKey = '';
let privateKey = '';
const subject = process.env.VAPID_SUBJECT || 'mailto:noreply@memoria.local';

/** 起動時に env or data/vapid.json から VAPID 鍵を読み込み、 web-push を構成 */
export function initWebPush(dataDir) {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    publicKey = process.env.VAPID_PUBLIC_KEY;
    privateKey = process.env.VAPID_PRIVATE_KEY;
  } else {
    const file = path.join(dataDir, 'vapid.json');
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      publicKey = j.publicKey;
      privateKey = j.privateKey;
    } else {
      const keys = webpush.generateVAPIDKeys();
      publicKey = keys.publicKey;
      privateKey = keys.privateKey;
      writeFileSync(file, JSON.stringify({ publicKey, privateKey }, null, 2));
      console.log(`[push] generated VAPID keys at ${file}`);
    }
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

export function getVapidPublicKey() {
  return configured ? publicKey : '';
}

/**
 * PushManager.subscribe() の結果を保存。 同一 endpoint があれば再有効化
 * (revokedAt を null に戻す)。 戻り値は保存後の row id。
 */
export function saveSubscription(db, { endpoint, p256dh, auth, label, userAgent }) {
  if (!endpoint || !p256dh || !auth) {
    throw new Error('endpoint, p256dh, auth are required');
  }
  const existing = findPushSubscriptionByEndpoint(db, endpoint);
  if (existing) {
    return insertPushSubscription(db, {
      id: existing.id,
      endpoint,
      p256dh,
      auth,
      label: label ?? existing.label ?? null,
      userAgent: userAgent ?? existing.user_agent ?? null,
      revokedAt: null,
    });
  }
  return insertPushSubscription(db, {
    endpoint,
    p256dh,
    auth,
    label: label ?? null,
    userAgent: userAgent ?? null,
  });
}

/**
 * 全アクティブ subscription に payload を送る。 410/404 は revoke 扱い。
 * 戻り値: { sent, revoked, errors }。 通知失敗で main flow を止めない。
 */
export async function sendPushToAll(db, payload) {
  if (!configured) {
    return { sent: 0, revoked: 0, errors: [{ message: 'VAPID not configured' }] };
  }
  const subs = listActivePushSubscriptions(db);
  let sent = 0;
  let revoked = 0;
  const errors = [];
  const json = JSON.stringify(payload ?? {});

  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        json,
      );
      sent += 1;
    } catch (err) {
      const status = err && typeof err === 'object' && 'statusCode' in err
        ? Number(err.statusCode)
        : 0;
      if (status === 404 || status === 410) {
        markPushSubscriptionRevoked(db, s.id);
        revoked += 1;
      } else {
        errors.push({
          id: s.id,
          status,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { sent, revoked, errors };
}
