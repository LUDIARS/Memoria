import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAlexaRequest, type AlexaSkillDeps } from './skill.js';
import { AlexaRequestEnvelopeSchema, type AlexaRequestEnvelope } from './types.js';

function envelope(request: Record<string, unknown>): AlexaRequestEnvelope {
  return AlexaRequestEnvelopeSchema.parse({
    version: '1.0',
    context: {
      System: {
        application: { applicationId: 'skill-1' },
        user: { userId: 'user-1' },
        apiEndpoint: 'https://api.fe.amazon.com',
      },
    },
    request: {
      requestId: 'request-1',
      timestamp: '2026-07-10T10:00:00.000Z',
      locale: 'ja-JP',
      ...request,
    },
  });
}

function deps(overrides: Partial<AlexaSkillDeps> = {}): AlexaSkillDeps {
  return {
    createTask: ({ title }) => ({
      created: true,
      task: {
        id: 1,
        title,
        details: null,
        status: 'todo',
        kind: 'task',
        creator_type: 'human',
        due_at: null,
        share_actio: 0,
        shared_at: null,
        shared_origin: null,
        category: null,
        created_at: '2026-07-10T10:00:00.000Z',
        updated_at: '2026-07-10T10:00:00.000Z',
      },
    }),
    takeNotifications: () => ({ items: [], remaining: 0 }),
    applySubscriptionChange: () => {},
    ...overrides,
  };
}

test('CreateTaskIntentからタスクを登録する', () => {
  let received: { requestId: string; title: string } | null = null;
  const response = handleAlexaRequest(envelope({
    type: 'IntentRequest',
    intent: {
      name: 'CreateTaskIntent',
      slots: { TaskTitle: { name: 'TaskTitle', value: ' 牛乳を買う ' } },
    },
  }), deps({
    createTask: (input) => {
      received = input;
      return deps().createTask(input);
    },
  }));
  assert.deepEqual(received, { requestId: 'request-1', title: '牛乳を買う' });
  assert.match(response.response.outputSpeech?.text ?? '', /タスクに追加しました/);
});

test('空のタスク名は登録せず再入力を促す', () => {
  let called = false;
  const response = handleAlexaRequest(envelope({
    type: 'IntentRequest',
    intent: { name: 'CreateTaskIntent', slots: {} },
  }), deps({
    createTask: (input) => {
      called = true;
      return deps().createTask(input);
    },
  }));
  assert.equal(called, false);
  assert.equal(response.response.shouldEndSession, false);
  assert.ok(response.response.reprompt);
});

test('LaunchRequestは取得した未読通知を読み上げる', () => {
  const response = handleAlexaRequest(envelope({ type: 'LaunchRequest' }), deps({
    takeNotifications: () => ({
      items: [{
        id: 'n1',
        title: '雨のお知らせ',
        body: '傘を持ってください',
        createdAt: '2026-07-10T10:00:00.000Z',
      }],
      remaining: 2,
    }),
  }));
  const speech = response.response.outputSpeech?.text ?? '';
  assert.match(speech, /雨のお知らせ/);
  assert.match(speech, /残り2件/);
});

test('購読変更イベントを保存依頼へ変換する', () => {
  let received: Parameters<AlexaSkillDeps['applySubscriptionChange']>[0] | null = null;
  handleAlexaRequest(envelope({
    type: 'AlexaSkillEvent.ProactiveSubscriptionChanged',
    body: { subscriptions: [{ eventName: 'AMAZON.MessageAlert.Activated' }] },
  }), deps({ applySubscriptionChange: (input) => { received = input; } }));
  assert.deepEqual(received, {
    userId: 'user-1',
    apiEndpoint: 'https://api.fe.amazon.com',
    timestamp: '2026-07-10T10:00:00.000Z',
    subscriptions: ['AMAZON.MessageAlert.Activated'],
  });
});
