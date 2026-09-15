// /api/notifications — 他サービス (Actio 等) から個人宛て通知を受け取り、 WebPush + Alexa へ流す。
// Spec: spec/interface/notifications.md
//
// Memoria はシングルユーザー・loopback 前提なので、 既存 /api/* と同じ信頼境界で受ける。
// 配送そのものは既存の sendNotificationToAll に任せ、 ここは入力の検証だけを持つ。

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { sendNotificationToAll, type NotificationSendResult } from '../notifications.js';
import type { PushPayload } from '../push.js';

type Db = BetterSqlite3.Database;

const TITLE_MAX = 200;
const BODY_MAX = 2000;
const TAG_MAX = 128;
const LABEL_MAX = 128;
const LABEL_PATTERN = /^[A-Za-z0-9._:-]+$/;

export interface InboundNotification {
  title: string;
  body: string;
  url: string;
  tag: string;
  source: string;
  event: string | null;
  taskId: string | null;
}

export type InboundNotificationParse =
  | { ok: true; value: InboundNotification }
  | { ok: false; error: string };

function readLabel(value: unknown, field: string, required: boolean): { value: string | null } | { error: string } {
  if (value === undefined || value === null) return required ? { error: `${field} is required` } : { value: null };
  if (typeof value !== 'string' || value.length === 0 || value.length > LABEL_MAX || !LABEL_PATTERN.test(value)) {
    return { error: `${field} must be 1-${LABEL_MAX} characters of letters, digits, '.', '_', ':' or '-'` };
  }
  return { value };
}

/** 相対パスか http(s) の URL だけを通す (javascript: 等を通知のクリック先にしない)。 */
function isSafeUrl(value: string): boolean {
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseInboundNotification(input: unknown): InboundNotificationParse {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, error: 'body must be a JSON object' };
  const body = input as Record<string, unknown>;
  if (typeof body.title !== 'string' || body.title.trim().length === 0) return { ok: false, error: 'title is required' };
  if (body.title.length > TITLE_MAX) return { ok: false, error: `title must be at most ${TITLE_MAX} characters` };
  if (body.body !== undefined && typeof body.body !== 'string') return { ok: false, error: 'body must be a string' };
  if (typeof body.body === 'string' && body.body.length > BODY_MAX) return { ok: false, error: `body must be at most ${BODY_MAX} characters` };
  if (body.url !== undefined && (typeof body.url !== 'string' || !isSafeUrl(body.url))) {
    return { ok: false, error: 'url must be a relative path or an http(s) URL' };
  }
  if (body.tag !== undefined && (typeof body.tag !== 'string' || body.tag.length === 0 || body.tag.length > TAG_MAX)) {
    return { ok: false, error: `tag must be 1-${TAG_MAX} characters` };
  }
  const source = readLabel(body.source, 'source', true);
  if ('error' in source) return { ok: false, error: source.error };
  const event = readLabel(body.event, 'event', false);
  if ('error' in event) return { ok: false, error: event.error };
  const taskId = readLabel(body.task_id, 'task_id', false);
  if ('error' in taskId) return { ok: false, error: taskId.error };
  const tag = typeof body.tag === 'string'
    ? body.tag
    : [source.value, event.value, taskId.value].filter((part): part is string => part !== null).join(':');
  return {
    ok: true,
    value: {
      title: body.title.trim(),
      body: typeof body.body === 'string' ? body.body : '',
      url: typeof body.url === 'string' ? body.url : '/',
      tag,
      source: source.value as string,
      event: event.value,
      taskId: taskId.value,
    },
  };
}

export interface NotificationsRouterDeps {
  db: Db;
  /** テストで配送を差し替えるための注入点。 省略時は WebPush + Alexa。 */
  send?: (db: Db, payload: PushPayload) => Promise<NotificationSendResult>;
}

export function makeNotificationsRouter(deps: NotificationsRouterDeps): Hono {
  const send = deps.send ?? sendNotificationToAll;
  const r = new Hono();

  r.post('/api/notifications', async (c: Context) => {
    const parsed = parseInboundNotification(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const { title, body, url, tag, source, event, taskId } = parsed.value;
    const result = await send(deps.db, { title, body, url, tag, icon: '/icon-192.svg', source, event, task_id: taskId });
    return c.json({ ok: true, push: result.push, alexa: { status: result.alexa.status } }, 202);
  });

  return r;
}
