// Discord の★評価ボタン。 customId の往復と、 後付け評価がウォッチ対象に効くことを見る。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { DEFAULT_BOOKS_CONFIG, ensureBooksSchema, insertBook } from '../books/index.js';
import { deriveWatchTargets } from '../books/index.js';
import { rateBook } from './actions/book.js';
import { isBookRatingButton, parseRatingCustomId, ratingRow } from './book-commands.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
  ensureBooksSchema(db);
  return db;
}

test('★1〜5 のボタンが並び、 customId に本の id が入る', () => {
  const row = ratingRow(42).toJSON();
  assert.equal(row.components.length, 5);
  const ids = row.components.map((c) => (c as { custom_id: string }).custom_id);
  assert.deepEqual(ids, [1, 2, 3, 4, 5].map((n) => `book-rate:42:${n}`));
});

test('customId を (bookId, rating) に戻す。 範囲外・別機能のボタンは弾く', () => {
  assert.deepEqual(parseRatingCustomId('book-rate:42:4'), { bookId: 42, rating: 4 });
  assert.equal(parseRatingCustomId('book-rate:42:9'), null);
  assert.equal(parseRatingCustomId('book-rate:0:3'), null);
  assert.equal(parseRatingCustomId('task-done:42:4'), null);
  assert.equal(isBookRatingButton('book-rate:1:5'), true);
  assert.equal(isBookRatingButton('recommend-dismiss:1'), false);
});

test('★を後付けするとウォッチ対象になる', () => {
  const db = openTestDb();
  const book = insertBook(db, { title: '沈黙の艦隊', authors: ['かわぐちかいじ'] });
  assert.deepEqual(deriveWatchTargets(db, DEFAULT_BOOKS_CONFIG), []);

  const result = rateBook(db, book.id, 5);
  assert.equal(result?.book.rating, 5);
  assert.match(result?.message ?? '', /新刊チェックの対象になりました/);
  assert.deepEqual(
    deriveWatchTargets(db, DEFAULT_BOOKS_CONFIG).map((t) => t.value),
    ['かわぐちかいじ'],
  );
});

test('★3 以下ならウォッチ対象にならないと伝える', () => {
  const db = openTestDb();
  const book = insertBook(db, { title: '普通の本', authors: ['著者'] });
  const result = rateBook(db, book.id, 2);
  assert.match(result?.message ?? '', /対象は★4 以上/);
  assert.deepEqual(deriveWatchTargets(db, DEFAULT_BOOKS_CONFIG), []);
});

test('消えた本のボタンを押しても落ちない', () => {
  const db = openTestDb();
  assert.equal(rateBook(db, 999, 5), null);
});
