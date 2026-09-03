import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ChannelType, type Client } from 'discord.js';
import { ensureBooksSchema } from '../../books/schema.js';
import { listPendingNotifications, recordNewRelease } from '../../books/store.js';
import type { BookCandidate } from '../../books/types.js';
import { postPendingBookNotices } from './books.js';

function openTestDb(withChannel = true): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
  ensureBooksSchema(db);
  if (withChannel) {
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
      .run('discord.channel.announce_id', 'announce-channel');
  }
  return db;
}

function addPending(db: Database.Database): void {
  const candidate: BookCandidate = {
    isbn13: null,
    title: '新刊',
    authors: ['著者'],
    publisher: null,
    series: null,
    publishedOn: '2026-09-03',
    coverUrl: null,
    url: null,
    source: 'ndl',
    rating: null,
    ratingCount: null,
    salesRank: null,
  };
  recordNewRelease(db, 'author', '著者', candidate);
}

function clientWithSend(send: () => Promise<unknown>): Client {
  return {
    channels: {
      fetch: async () => ({ type: ChannelType.GuildText, send }),
    },
  } as unknown as Client;
}

test('Discord 送信失敗時は新刊を未通知のまま残す', async () => {
  const db = openTestDb();
  addPending(db);
  const sent = await postPendingBookNotices(clientWithSend(async () => {
    throw new Error('send failed');
  }), db);

  assert.equal(sent, 0);
  assert.equal(listPendingNotifications(db).length, 1);
});

test('Discord 送信成功後だけ新刊を通知済みにする', async () => {
  const db = openTestDb();
  addPending(db);
  const sent = await postPendingBookNotices(clientWithSend(async () => ({})), db);

  assert.equal(sent, 1);
  assert.equal(listPendingNotifications(db).length, 0);
});

test('通知チャンネルが無いときは新刊を未通知のまま残す', async () => {
  const db = openTestDb(false);
  addPending(db);
  const sent = await postPendingBookNotices(clientWithSend(async () => ({})), db);

  assert.equal(sent, 0);
  assert.equal(listPendingNotifications(db).length, 1);
});

test('アナウンス無効時は新刊を未通知のまま残す', async () => {
  const db = openTestDb();
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
    .run('features.discord.announce', 'false');
  addPending(db);
  const sent = await postPendingBookNotices(clientWithSend(async () => ({})), db);

  assert.equal(sent, 0);
  assert.equal(listPendingNotifications(db).length, 1);
});
