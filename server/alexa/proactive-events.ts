import { z } from 'zod';
import type { AlexaConfig } from './config.js';
import { proactiveEventsUrl } from './config.js';
import type { AlexaSubscription } from './store.js';

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const TOKEN_EXPIRY_SKEW_SECONDS = 60;

const LwaTokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string().min(1),
});

export interface AlexaProactiveSender {
  sendUnreadCount(target: AlexaSubscription, count: number): Promise<void>;
}

export interface AlexaProactiveSenderDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function createAlexaProactiveSender(
  config: AlexaConfig,
  deps: AlexaProactiveSenderDeps = {},
): AlexaProactiveSender {
  const clientId = config.clientId;
  const clientSecret = config.clientSecret;
  if (!config.proactiveEnabled || !clientId || !clientSecret) {
    throw new Error('Alexa proactive credentials are not configured');
  }
  const credentials: { clientId: string; clientSecret: string } = { clientId, clientSecret };

  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  let tokenCache: { accessToken: string; expiresAtMs: number } | null = null;

  async function accessToken(): Promise<string> {
    const currentTime = now().getTime();
    if (tokenCache && tokenCache.expiresAtMs > currentTime) return tokenCache.accessToken;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      scope: 'alexa::proactive_events',
    });
    const response = await fetchImpl(LWA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Alexa LWA token request failed with HTTP ${response.status}`);
    const parsed = LwaTokenSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Alexa LWA token response is invalid');

    const cacheSeconds = Math.max(1, parsed.data.expires_in - TOKEN_EXPIRY_SKEW_SECONDS);
    tokenCache = {
      accessToken: parsed.data.access_token,
      expiresAtMs: currentTime + cacheSeconds * 1000,
    };
    return tokenCache.accessToken;
  }

  return {
    async sendUnreadCount(target: AlexaSubscription, count: number): Promise<void> {
      if (!target.enabled) throw new Error('Alexa proactive subscription is disabled');
      if (!Number.isInteger(count) || count <= 0) throw new Error('Alexa unread count must be positive');

      const timestamp = now();
      const expiryTime = new Date(timestamp.getTime() + 24 * 60 * 60 * 1000);
      const token = await accessToken();
      const response = await fetchImpl(
        proactiveEventsUrl(target.apiEndpoint, config.proactiveStage),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            timestamp: timestamp.toISOString(),
            referenceId: 'memoria-unread-notifications',
            expiryTime: expiryTime.toISOString(),
            event: {
              name: 'AMAZON.MessageAlert.Activated',
              payload: {
                state: { status: 'UNREAD', freshness: 'NEW' },
                messageGroup: {
                  creator: { name: 'Memoria' },
                  count,
                },
              },
            },
            relevantAudience: {
              type: 'Unicast',
              payload: { user: target.userId },
            },
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        throw new Error(`Alexa Proactive Events request failed with HTTP ${response.status}`);
      }
    },
  };
}
