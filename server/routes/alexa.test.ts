import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { openDb } from '../db.js';
import { loadAlexaConfig } from '../alexa/config.js';
import { makeAlexaRouter } from './alexa.js';

function requestBody(applicationId = 'skill-1'): string {
  return JSON.stringify({
    version: '1.0',
    context: {
      System: {
        application: { applicationId },
        user: { userId: 'user-1' },
        apiEndpoint: 'https://api.fe.amazon.com',
      },
    },
    request: {
      type: 'IntentRequest',
      requestId: 'request-1',
      timestamp: '2026-07-10T10:00:00.000Z',
      locale: 'ja-JP',
      intent: {
        name: 'CreateTaskIntent',
        slots: { TaskTitle: { name: 'TaskTitle', value: '牛乳を買う' } },
      },
    },
  });
}

test('署名検証済みAlexa requestからタスクを登録する', async () => {
  const db = openDb(':memory:');
  try {
    let verifiedBody = '';
    const app = new Hono();
    app.route('/', makeAlexaRouter({
      db,
      config: loadAlexaConfig({ MEMORIA_ALEXA_SKILL_ID: 'skill-1' }),
      verifyRequest: async (rawBody) => { verifiedBody = rawBody; },
    }));
    const body = requestBody();
    const response = await app.request('/api/alexa/skill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal(verifiedBody, body);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count, 1);
  } finally {
    db.close();
  }
});

test('Alexa application ID不一致を拒否する', async () => {
  const db = openDb(':memory:');
  try {
    const app = new Hono();
    app.route('/', makeAlexaRouter({
      db,
      config: loadAlexaConfig({ MEMORIA_ALEXA_SKILL_ID: 'skill-1' }),
      verifyRequest: async () => {},
    }));
    const response = await app.request('/api/alexa/skill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody('other-skill'),
    });
    assert.equal(response.status, 403);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count, 0);
  } finally {
    db.close();
  }
});

test('Alexa署名検証失敗を400にする', async () => {
  const db = openDb(':memory:');
  try {
    const app = new Hono();
    app.route('/', makeAlexaRouter({
      db,
      config: loadAlexaConfig({ MEMORIA_ALEXA_SKILL_ID: 'skill-1' }),
      verifyRequest: async () => { throw new Error('bad signature'); },
    }));
    const response = await app.request('/api/alexa/skill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(),
    });
    assert.equal(response.status, 400);
  } finally {
    db.close();
  }
});
