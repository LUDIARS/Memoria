import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { getAppSettings, setAppSettings } from '../db.js';
import { normalizeAlexaApiEndpoint } from './config.js';

type Db = BetterSqlite3.Database;

const PENDING_KEY = 'features.alexa.notifications.pending';
const SUBSCRIPTION_USER_KEY = 'features.alexa.proactive.user_id';
const SUBSCRIPTION_ENDPOINT_KEY = 'features.alexa.proactive.api_endpoint';
const SUBSCRIPTION_ENABLED_KEY = 'features.alexa.proactive.enabled';
const SUBSCRIPTION_UPDATED_KEY = 'features.alexa.proactive.updated_at';
const PROCESSED_REQUESTS_KEY = 'features.alexa.processed_requests';

const MAX_PENDING = 20;
const MAX_PROCESSED_REQUESTS = 50;

const PendingNotificationSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  body: z.string(),
  createdAt: z.string().min(1),
});

const ProcessedRequestSchema = z.object({
  requestId: z.string().min(1),
  taskId: z.number().int().positive(),
  createdAt: z.string().min(1),
});

export type AlexaPendingNotification = z.infer<typeof PendingNotificationSchema>;

export interface AlexaSubscription {
  userId: string;
  apiEndpoint: string;
  enabled: boolean;
  updatedAt: string;
}

interface StoreClock {
  now: () => Date;
  id: () => string;
}

const defaultClock: StoreClock = {
  now: () => new Date(),
  id: () => randomUUID(),
};

function parseArray<T>(raw: string | null | undefined, schema: z.ZodType<T>): T[] {
  if (!raw) return [];
  try {
    const result = z.array(schema).safeParse(JSON.parse(raw));
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

export function normalizeAlexaText(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function readPending(db: Db): AlexaPendingNotification[] {
  return parseArray(getAppSettings(db)[PENDING_KEY], PendingNotificationSchema);
}

function writePending(db: Db, items: AlexaPendingNotification[]): void {
  setAppSettings(db, { [PENDING_KEY]: JSON.stringify(items) });
}

export function enqueueAlexaNotification(
  db: Db,
  input: { title?: unknown; body?: unknown },
  clock: StoreClock = defaultClock,
): AlexaPendingNotification {
  const title = normalizeAlexaText(input.title, 120) || 'Memoria';
  const body = normalizeAlexaText(input.body, 500);
  const item: AlexaPendingNotification = {
    id: clock.id(),
    title,
    body,
    createdAt: clock.now().toISOString(),
  };
  const items = [...readPending(db), item].slice(-MAX_PENDING);
  writePending(db, items);
  return item;
}

export function pendingAlexaNotificationCount(db: Db): number {
  return readPending(db).length;
}

export function takeAlexaNotifications(
  db: Db,
  limit: number,
): { items: AlexaPendingNotification[]; remaining: number } {
  const safeLimit = Math.max(0, Math.min(Math.trunc(limit), MAX_PENDING));
  const pending = readPending(db);
  const items = pending.slice(0, safeLimit);
  const remainingItems = pending.slice(items.length);
  writePending(db, remainingItems);
  return { items, remaining: remainingItems.length };
}

export function applyAlexaSubscriptionChange(
  db: Db,
  input: {
    userId: string;
    apiEndpoint: string;
    timestamp: string;
    subscriptions: string[];
  },
): boolean {
  const userId = input.userId.trim();
  const apiEndpoint = normalizeAlexaApiEndpoint(input.apiEndpoint);
  const incomingTime = Date.parse(input.timestamp);
  if (!userId) throw new Error('Alexa subscription user ID is required');
  if (!apiEndpoint) throw new Error('Alexa subscription API endpoint is invalid');
  if (!Number.isFinite(incomingTime)) throw new Error('Alexa subscription timestamp is invalid');

  const settings = getAppSettings(db);
  const currentTime = Date.parse(settings[SUBSCRIPTION_UPDATED_KEY] ?? '');
  if (Number.isFinite(currentTime) && incomingTime <= currentTime) return false;

  const enabled = input.subscriptions.includes('AMAZON.MessageAlert.Activated');
  setAppSettings(db, {
    [SUBSCRIPTION_USER_KEY]: userId,
    [SUBSCRIPTION_ENDPOINT_KEY]: apiEndpoint,
    [SUBSCRIPTION_ENABLED_KEY]: enabled ? '1' : '0',
    [SUBSCRIPTION_UPDATED_KEY]: new Date(incomingTime).toISOString(),
  });
  return true;
}

export function getAlexaSubscription(db: Db): AlexaSubscription | null {
  const settings = getAppSettings(db);
  const userId = settings[SUBSCRIPTION_USER_KEY]?.trim();
  const apiEndpoint = normalizeAlexaApiEndpoint(settings[SUBSCRIPTION_ENDPOINT_KEY] ?? '');
  const updatedAt = settings[SUBSCRIPTION_UPDATED_KEY]?.trim();
  if (!userId || !apiEndpoint || !updatedAt || !Number.isFinite(Date.parse(updatedAt))) return null;
  return {
    userId,
    apiEndpoint,
    enabled: settings[SUBSCRIPTION_ENABLED_KEY] === '1',
    updatedAt,
  };
}

function readProcessedRequests(db: Db): z.infer<typeof ProcessedRequestSchema>[] {
  return parseArray(getAppSettings(db)[PROCESSED_REQUESTS_KEY], ProcessedRequestSchema);
}

export function findProcessedAlexaTaskId(db: Db, requestId: string): number | null {
  const normalized = requestId.trim();
  if (!normalized) return null;
  return readProcessedRequests(db).find((item) => item.requestId === normalized)?.taskId ?? null;
}

export function rememberProcessedAlexaTask(
  db: Db,
  requestId: string,
  taskId: number,
  now: Date = new Date(),
): void {
  const normalized = requestId.trim();
  if (!normalized) throw new Error('Alexa request ID is required');
  const next = [
    ...readProcessedRequests(db).filter((item) => item.requestId !== normalized),
    { requestId: normalized, taskId, createdAt: now.toISOString() },
  ].slice(-MAX_PROCESSED_REQUESTS);
  setAppSettings(db, { [PROCESSED_REQUESTS_KEY]: JSON.stringify(next) });
}
