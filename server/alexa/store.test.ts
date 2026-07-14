import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import {
  applyAlexaSubscriptionChange,
  enqueueAlexaNotification,
  getAlexaSubscription,
  pendingAlexaNotificationCount,
  takeAlexaNotifications,
} from './store.js';

test('Alexa通知キューを20件に制限し、読み上げた分だけ削除する', () => {
  const db = openDb(':memory:');
  try {
    for (let index = 0; index < 22; index += 1) {
      enqueueAlexaNotification(db, { title: `title ${index}`, body: `body ${index}` }, {
        id: () => `id-${index}`,
        now: () => new Date(`2026-07-10T00:${String(index).padStart(2, '0')}:00.000Z`),
      });
    }
    assert.equal(pendingAlexaNotificationCount(db), 20);
    const taken = takeAlexaNotifications(db, 5);
    assert.equal(taken.items.length, 5);
    assert.equal(taken.items[0]?.title, 'title 2');
    assert.equal(taken.remaining, 15);
    assert.equal(pendingAlexaNotificationCount(db), 15);
  } finally {
    db.close();
  }
});

test('古い購読イベントは新しいAlexa購読状態を上書きしない', () => {
  const db = openDb(':memory:');
  try {
    const applied = applyAlexaSubscriptionChange(db, {
      userId: 'user-1',
      apiEndpoint: 'https://api.fe.amazon.com',
      timestamp: '2026-07-10T10:00:00.000Z',
      subscriptions: ['AMAZON.MessageAlert.Activated'],
    });
    const ignored = applyAlexaSubscriptionChange(db, {
      userId: 'user-1',
      apiEndpoint: 'https://api.fe.amazon.com',
      timestamp: '2026-07-10T09:00:00.000Z',
      subscriptions: [],
    });
    assert.equal(applied, true);
    assert.equal(ignored, false);
    assert.equal(getAlexaSubscription(db)?.enabled, true);
  } finally {
    db.close();
  }
});

test('不正なAlexa API endpointを購読状態へ保存しない', () => {
  const db = openDb(':memory:');
  try {
    assert.throws(() => applyAlexaSubscriptionChange(db, {
      userId: 'user-1',
      apiEndpoint: 'https://example.com',
      timestamp: '2026-07-10T10:00:00.000Z',
      subscriptions: ['AMAZON.MessageAlert.Activated'],
    }), /endpoint is invalid/);
    assert.equal(getAlexaSubscription(db), null);
  } finally {
    db.close();
  }
});
