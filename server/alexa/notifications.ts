import type BetterSqlite3 from 'better-sqlite3';
import type { AlexaConfig } from './config.js';
import { loadAlexaConfig } from './config.js';
import {
  enqueueAlexaNotification,
  getAlexaSubscription,
  pendingAlexaNotificationCount,
} from './store.js';
import {
  createAlexaProactiveSender,
  type AlexaProactiveSender,
} from './proactive-events.js';

type Db = BetterSqlite3.Database;

export type AlexaNotificationStatus = 'disabled' | 'queued' | 'sent' | 'failed';

export interface AlexaNotificationResult {
  status: AlexaNotificationStatus;
  pending: number;
  error?: string;
}

export interface AlexaNotificationOptions {
  config?: AlexaConfig;
  sender?: AlexaProactiveSender;
}

let cachedSender: {
  clientId: string;
  clientSecret: string;
  stage: string;
  sender: AlexaProactiveSender;
} | null = null;

function senderFor(config: AlexaConfig): AlexaProactiveSender {
  if (!config.clientId || !config.clientSecret) {
    throw new Error('Alexa proactive credentials are not configured');
  }
  if (
    cachedSender
    && cachedSender.clientId === config.clientId
    && cachedSender.clientSecret === config.clientSecret
    && cachedSender.stage === config.proactiveStage
  ) {
    return cachedSender.sender;
  }
  const sender = createAlexaProactiveSender(config);
  cachedSender = {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    stage: config.proactiveStage,
    sender,
  };
  return sender;
}

export async function sendAlexaNotification(
  db: Db,
  payload: { title?: unknown; body?: unknown },
  options: AlexaNotificationOptions = {},
): Promise<AlexaNotificationResult> {
  let config: AlexaConfig;
  try {
    config = options.config ?? loadAlexaConfig();
  } catch (error: unknown) {
    return {
      status: 'failed',
      pending: pendingAlexaNotificationCount(db),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!config.inboundEnabled) return { status: 'disabled', pending: 0 };

  enqueueAlexaNotification(db, payload);
  const pending = pendingAlexaNotificationCount(db);
  const subscription = getAlexaSubscription(db);
  if (!config.proactiveEnabled || !subscription?.enabled) {
    return { status: 'queued', pending };
  }

  try {
    const sender = options.sender ?? senderFor(config);
    await sender.sendUnreadCount(subscription, pending);
    return { status: 'sent', pending };
  } catch (error: unknown) {
    return {
      status: 'failed',
      pending,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
