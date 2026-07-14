import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAlexaConfig } from './config.js';
import { createAlexaProactiveSender } from './proactive-events.js';

test('LWA tokenを再利用してFar Eastのdevelopment endpointへ未読件数を送る', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/auth/o2/token')) {
      return Response.json({ access_token: 'token-1', expires_in: 3600, token_type: 'bearer' });
    }
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  const config = loadAlexaConfig({
    MEMORIA_ALEXA_SKILL_ID: 'skill-1',
    MEMORIA_ALEXA_CLIENT_ID: 'client-1',
    MEMORIA_ALEXA_CLIENT_SECRET: 'secret-1',
    MEMORIA_ALEXA_PROACTIVE_STAGE: 'development',
  });
  const sender = createAlexaProactiveSender(config, {
    fetchImpl: fakeFetch,
    now: () => new Date('2026-07-10T10:00:00.000Z'),
  });
  const target = {
    userId: 'user-1',
    apiEndpoint: 'https://api.fe.amazon.com',
    enabled: true,
    updatedAt: '2026-07-10T09:00:00.000Z',
  };

  await sender.sendUnreadCount(target, 2);
  await sender.sendUnreadCount(target, 3);

  assert.equal(calls.filter((call) => call.url.includes('/auth/o2/token')).length, 1);
  const proactiveCalls = calls.filter((call) => call.url.includes('/v1/proactiveEvents'));
  assert.equal(proactiveCalls.length, 2);
  assert.equal(
    proactiveCalls[0]?.url,
    'https://api.fe.amazon.com/v1/proactiveEvents/stages/development',
  );
  const payload = JSON.parse(String(proactiveCalls[0]?.init?.body)) as {
    event: { payload: { messageGroup: { count: number; creator: { name: string } } } };
    relevantAudience: { payload: { user: string } };
  };
  assert.equal(payload.event.payload.messageGroup.count, 2);
  assert.equal(payload.event.payload.messageGroup.creator.name, 'Memoria');
  assert.equal(payload.relevantAudience.payload.user, 'user-1');
});

test('Proactive EventsのHTTPエラーを明示失敗にする', async () => {
  const fakeFetch = (async (input: string | URL | Request) => {
    if (String(input).includes('/auth/o2/token')) {
      return Response.json({ access_token: 'token-1', expires_in: 3600, token_type: 'bearer' });
    }
    return new Response(null, { status: 403 });
  }) as typeof fetch;
  const sender = createAlexaProactiveSender(loadAlexaConfig({
    MEMORIA_ALEXA_SKILL_ID: 'skill-1',
    MEMORIA_ALEXA_CLIENT_ID: 'client-1',
    MEMORIA_ALEXA_CLIENT_SECRET: 'secret-1',
  }), { fetchImpl: fakeFetch });

  await assert.rejects(() => sender.sendUnreadCount({
    userId: 'user-1',
    apiEndpoint: 'https://api.fe.amazon.com',
    enabled: true,
    updatedAt: '2026-07-10T09:00:00.000Z',
  }, 1), /HTTP 403/);
});
