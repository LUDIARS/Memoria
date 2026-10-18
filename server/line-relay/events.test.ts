import test from 'node:test';
import assert from 'node:assert/strict';
import { LineRelayBodyError, parseLineRelayEvents } from './events.js';

// 架空の ID だけを使う。

test('トークを user / group / room で表し、ボットへのメンションを外す', () => {
  const events = parseLineRelayEvents({
    destination: 'Ufakebot0000',
    events: [
      { type: 'message', replyToken: 'fake-1', source: { type: 'user', userId: 'Ufakeuser0000' }, message: { type: 'text', text: 'きょうのタスク' } },
      {
        type: 'message', replyToken: 'fake-2', source: { type: 'group', groupId: 'Cfakegroup0000', userId: 'Ufakeuser0000' },
        message: { type: 'text', text: '@Memoria タスク 牛乳を買う', mention: { mentionees: [{ index: 0, length: 8, isSelf: true }] } },
      },
      { type: 'postback', replyToken: 'fake-3', source: { type: 'room', roomId: 'Rfakeroom0000' }, postback: { data: 'mm:no:abcdefghijklmnop' } },
      { type: 'leave', source: { type: 'group', groupId: 'Cfakegroup0000' } },
      { type: 'message', replyToken: 'fake-4', source: { type: 'user', userId: 'Ufakeuser0000' }, message: { type: 'sticker' } },
      { type: 'unfollow', source: { type: 'user', userId: 'Ufakeuser0000' } },
    ],
  });
  assert.deepEqual(events, [
    { type: 'text', talk: 'user:Ufakeuser0000', replyToken: 'fake-1', text: 'きょうのタスク' },
    { type: 'text', talk: 'group:Cfakegroup0000', replyToken: 'fake-2', text: 'タスク 牛乳を買う' },
    { type: 'postback', talk: 'room:Rfakeroom0000', replyToken: 'fake-3', data: 'mm:no:abcdefghijklmnop' },
    { type: 'leave', talk: 'group:Cfakegroup0000' },
  ]);
});

test('events の無い本文は不正として扱う', () => {
  assert.throws(() => parseLineRelayEvents({ destination: 'x' }), LineRelayBodyError);
  assert.throws(() => parseLineRelayEvents(null), LineRelayBodyError);
});
