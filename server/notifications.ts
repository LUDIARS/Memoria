import type BetterSqlite3 from 'better-sqlite3';
import { sendAlexaNotification } from './alexa/notifications.js';
import {
  sendPushToAll,
  type PushPayload,
  type PushSendResult,
} from './push.js';

type Db = BetterSqlite3.Database;

export interface NotificationSendResult {
  push: PushSendResult;
  alexa: Awaited<ReturnType<typeof sendAlexaNotification>>;
}

export async function sendNotificationToAll(
  db: Db,
  payload: PushPayload,
): Promise<NotificationSendResult> {
  const [push, alexa] = await Promise.all([
    sendPushToAll(db, payload),
    sendAlexaNotification(db, payload),
  ]);
  if (alexa.status === 'failed') {
    console.warn(`[alexa] notification delivery failed: ${alexa.error ?? 'unknown error'}`);
  }
  return { push, alexa };
}
