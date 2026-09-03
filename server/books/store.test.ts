// books DAO のテスト (in-memory SQLite)。 重複排除と通知フラグの扱いを保証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureBooksSchema } from './schema.js';
import {
  blockedTitleKeys, countBooks, dismissSuggestion, findBook, insertBook, listNewReleases,
  listPendingNotifications, listSuggestions, markNotified, ownedTitleKeys, recordNewRelease,
  replaceSuggestions, updateBook,
} from './store.js';
import type { BookCandidate } from './types.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)');
  ensureBooksSchema(db);
  return db;
}

function candidate(overrides: Partial<BookCandidate> = {}): BookCandidate {
  return {
    isbn13: '9784065194656',
    title: '沈黙の艦隊 2',
    authors: ['かわぐち かいじ'],
    publisher: '講談社',
    series: null,
    publishedOn: '2026-09-01',
    coverUrl: null,
    url: 'https://example.com/book',
    source: 'ndl',
    rating: null,
    ratingCount: null,
    salesRank: null,
    ...overrides,
  };
}

test('insertBook は ISBN を正規化し、 title_key で所持判定できる', () => {
  const db = openTestDb();
  const book = insertBook(db, { title: '沈黙の艦隊 (講談社文庫)', isbn13: '978-4-06-519465-6', rating: 5 });
  assert.equal(book.isbn13, '9784065194656');
  assert.equal(findBook(db, '9784065194656', 'まったく別の題')?.id, book.id);
  assert.equal(findBook(db, null, '沈黙の艦隊')?.id, book.id);
  assert.ok(ownedTitleKeys(db).has('沈黙の艦隊'));
  assert.deepEqual(countBooks(db), { total: 1, favorites: 1, rated: 1 });
});

test('updateBook は渡した項目だけ書き換える', () => {
  const db = openTestDb();
  const book = insertBook(db, { title: '本', rating: 5, review: '面白い' });
  const updated = updateBook(db, book.id, { readOn: '2026-01-05' });
  assert.equal(updated?.rating, 5);
  assert.equal(updated?.review, '面白い');
  assert.equal(updated?.readOn, '2026-01-05');
});

test('recordNewRelease は同じ本を二度積まない', () => {
  const db = openTestDb();
  const first = recordNewRelease(db, 'author', 'かわぐち かいじ', candidate());
  const second = recordNewRelease(db, 'author', 'かわぐち かいじ', candidate());
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(listNewReleases(db).length, 1);
});

test('通知は notified_at が立つまで pending に残る', () => {
  const db = openTestDb();
  const saved = recordNewRelease(db, 'author', 'A', candidate());
  assert.equal(listPendingNotifications(db).length, 1);
  markNotified(db, [saved!.id]);
  assert.equal(listPendingNotifications(db).length, 0);
  assert.equal(listNewReleases(db).length, 1);
});

test('replaceSuggestions は未 dismiss を入れ替え、 dismiss はブロックに残る', () => {
  const db = openTestDb();
  replaceSuggestions(db, [
    { candidate: candidate({ title: '候補A' }), origin: 'llm', reason: 'r1', score: 1.2 },
    { candidate: candidate({ title: '候補B' }), origin: 'rakuten_ranking', reason: 'r2', score: 1.0 },
  ]);
  const suggestions = listSuggestions(db);
  assert.deepEqual(suggestions.map((s) => s.title), ['候補A', '候補B']);

  dismissSuggestion(db, suggestions[0].id);
  assert.deepEqual(listSuggestions(db).map((s) => s.title), ['候補B']);
  assert.equal(blockedTitleKeys(db).size, 1);

  replaceSuggestions(db, [{ candidate: candidate({ title: '候補C' }), origin: 'llm', reason: 'r3', score: 0.9 }]);
  assert.deepEqual(listSuggestions(db).map((s) => s.title), ['候補C']);
});
