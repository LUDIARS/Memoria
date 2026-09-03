// 既存行の書誌補完。 空欄だけ埋め、 本人が書いたものは触らないことを見る。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { DEFAULT_BOOKS_CONFIG } from './config.js';
import { enrichBook, enrichMissingBooks, needsEnrichment } from './enrich.js';
import { ensureBooksSchema } from './schema.js';
import { getBook, insertBook, listBooks, updateBook } from './store.js';
import type { BookCandidate } from './types.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
  ensureBooksSchema(db);
  return db;
}

function candidate(overrides: Partial<BookCandidate> = {}): BookCandidate {
  return {
    isbn13: '9784098607314', title: 'トリリオンゲーム', authors: ['稲垣 理一郎', '池上 遼一'],
    publisher: '小学館', series: 'ビッグコミックス', publishedOn: '2021-03-30',
    coverUrl: 'https://cover.example/1.jpg', url: null, source: 'google_books',
    rating: null, ratingCount: null, salesRank: null, ...overrides,
  };
}

const FOUND = { searchGoogleBooks: async () => [candidate()], enrichWithOpenBd: async (c: BookCandidate[]) => c };

test('著者も ISBN も無い行だけを補完対象にする', () => {
  const db = openTestDb();
  const empty = insertBook(db, { title: 'タイトルだけ' });
  const withAuthor = insertBook(db, { title: '著者あり', authors: ['著者'] });
  const withIsbn = insertBook(db, { title: 'ISBN あり', isbn13: '9784065194656' });
  assert.equal(needsEnrichment(getBook(db, empty.id)!), true);
  assert.equal(needsEnrichment(getBook(db, withAuthor.id)!), false);
  assert.equal(needsEnrichment(getBook(db, withIsbn.id)!), false);
});

test('空欄だけ埋め、評価・感想・タイトルは触らない', async () => {
  const db = openTestDb();
  const book = insertBook(db, { title: 'トリリオンゲーム', rating: 5, review: '面白い' });

  const result = await enrichBook(db, book.id, DEFAULT_BOOKS_CONFIG, FOUND);
  assert.deepEqual(result?.filled, ['著者', 'ISBN', '出版社', 'シリーズ', '発売日', '書影']);

  const after = getBook(db, book.id);
  assert.deepEqual(after?.authors, ['稲垣 理一郎', '池上 遼一']);
  assert.equal(after?.isbn13, '9784098607314');
  assert.equal(after?.title, 'トリリオンゲーム');   // 書誌側のタイトルで上書きしない
  assert.equal(after?.rating, 5);
  assert.equal(after?.review, '面白い');
});

test('既に埋まっている項目は上書きしない', async () => {
  const db = openTestDb();
  const book = insertBook(db, { title: 'トリリオンゲーム', authors: ['自分で書いた著者'], publisher: '自分の出版社' });
  const result = await enrichBook(db, book.id, DEFAULT_BOOKS_CONFIG, FOUND);

  assert.equal(result?.filled.includes('著者'), false);
  assert.equal(result?.filled.includes('出版社'), false);
  const after = getBook(db, book.id);
  assert.deepEqual(after?.authors, ['自分で書いた著者']);
  assert.equal(after?.publisher, '自分の出版社');
});

test('照会中に手編集された項目は上書きしない', async () => {
  const db = openTestDb();
  const book = insertBook(db, { title: 'トリリオンゲーム' });
  let resolveLookup!: (value: BookCandidate[]) => void;
  const lookup = new Promise<BookCandidate[]>((resolve) => { resolveLookup = resolve; });
  const enriching = enrichBook(db, book.id, DEFAULT_BOOKS_CONFIG, {
    searchGoogleBooks: async () => lookup,
    enrichWithOpenBd: async (candidates) => candidates,
  });

  updateBook(db, book.id, { authors: ['手入力の著者'], publisher: '手入力の出版社' });
  resolveLookup([candidate()]);
  await enriching;

  const after = getBook(db, book.id);
  assert.deepEqual(after?.authors, ['手入力の著者']);
  assert.equal(after?.publisher, '手入力の出版社');
  assert.equal(after?.isbn13, '9784098607314');
});

test('LLM 補完の出所を保存する', async () => {
  const db = openTestDb();
  const book = insertBook(db, { title: 'トリリオンゲーム' });
  await enrichBook(db, book.id, DEFAULT_BOOKS_CONFIG, {
    searchGoogleBooks: async () => [],
    searchNdl: async () => [],
    inferBibliography: async () => candidate({ source: 'llm_inferred' }),
    enrichWithOpenBd: async (candidates) => candidates,
  });
  assert.equal(getBook(db, book.id)?.source, 'llm_inferred');
});

test('書誌が引けなければ何も変えず warning を返す', async () => {
  const db = openTestDb();
  const book = insertBook(db, { title: '知らない本' });
  const result = await enrichBook(db, book.id, DEFAULT_BOOKS_CONFIG, {
    searchGoogleBooks: async () => { throw new Error('offline'); },
    searchNdl: async () => { throw new Error('offline'); },
    inferBibliography: async () => null,
  });
  assert.deepEqual(result?.filled, []);
  assert.match(result?.warning ?? '', /Google Books/);
  assert.deepEqual(getBook(db, book.id)?.authors, []);
});

test('一括補完は欠損行だけを対象にし、1 冊の失敗で止まらない', async () => {
  const db = openTestDb();
  insertBook(db, { title: 'トリリオンゲーム' });
  insertBook(db, { title: '壊れる本' });
  insertBook(db, { title: '著者あり', authors: ['著者'] });

  const result = await enrichMissingBooks(db, DEFAULT_BOOKS_CONFIG, 20, {
    searchGoogleBooks: async (query) => {
      if (query.freeText?.includes('壊れる本')) throw new Error('boom');
      return [candidate()];
    },
    searchNdl: async () => { throw new Error('boom'); },
    inferBibliography: async () => null,
    enrichWithOpenBd: async (c: BookCandidate[]) => c,
  });

  assert.equal(result.targets, 2);
  assert.equal(result.results.length, 2);
  assert.equal(listBooks(db).find((b) => b.title === 'トリリオンゲーム')?.isbn13, '9784098607314');
});

test('一括補完は失敗行を後ろへ回し、後続行を次回に処理する', async () => {
  const db = openTestDb();
  const inserted = Array.from({ length: 21 }, (_, index) => insertBook(
    db,
    { title: index === 20 ? '成功する本' : `失敗する本 ${index + 1}` },
    new Date(`2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`),
  ));
  const deps = {
    searchGoogleBooks: async (query: { freeText?: string }) => {
      if (query.freeText === '成功する本') return [candidate({ title: '成功する本' })];
      return [];
    },
    searchNdl: async () => [],
    inferBibliography: async () => null,
    enrichWithOpenBd: async (candidates: BookCandidate[]) => candidates,
  };

  await enrichMissingBooks(db, DEFAULT_BOOKS_CONFIG, 20, deps);
  await enrichMissingBooks(db, DEFAULT_BOOKS_CONFIG, 20, deps);

  assert.equal(getBook(db, inserted[20].id)?.isbn13, '9784098607314');
});
