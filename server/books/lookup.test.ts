// 書誌検索のフォールバック。 1 ソースが落ちても 500 にせず、 候補と警告を返す。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BOOKS_CONFIG } from './config.js';
import { lookupBibliography } from './lookup.js';
import { NDL_MEDIATYPE_BOOKS, buildNdlUrl } from './sources/ndl.js';
import type { BookCandidate } from './types.js';

function candidate(title: string, source: BookCandidate['source'] = 'ndl'): BookCandidate {
  return {
    isbn13: null, title, authors: ['著者'], publisher: null, series: null,
    publishedOn: '2026-01-01', coverUrl: null, url: null, source,
    rating: null, ratingCount: null, salesRank: null,
  };
}

const NO_OPENBD = { ...DEFAULT_BOOKS_CONFIG, sources: { ...DEFAULT_BOOKS_CONFIG.sources, openbd: false } };

test('NDL の mediatype は文字列 books — 数値だとエラーにならず 0 件になる', () => {
  assert.equal(NDL_MEDIATYPE_BOOKS, 'books');
  const url = buildNdlUrl({ creator: 'テスト著者', limit: 3 });
  assert.match(url, /mediatype=books/);
  assert.doesNotMatch(url, /mediatype=1(&|$)/);
  assert.match(url, /creator=/);
});

test('Google Books が落ちたら NDL に落として候補を返す', async () => {
  const ndlQueries: Array<{ title?: string; creator?: string }> = [];
  const result = await lookupBibliography(NO_OPENBD, { title: 'テスト本', author: 'テスト著者' }, {
    searchGoogleBooks: async () => { throw new Error('secret upstream detail'); },
    searchNdl: async (query) => { ndlQueries.push(query); return [candidate('NDL の本')]; },
  });
  assert.deepEqual(result.candidates.map((c) => c.title), ['NDL の本']);
  assert.equal(ndlQueries[0]?.title, 'テスト本');
  assert.equal(ndlQueries[0]?.creator, 'テスト著者');
  assert.equal(result.warning, '一部の書誌ソースが応答しませんでした (Google Books)');
  assert.doesNotMatch(result.warning, /secret upstream detail/);
});

test('Google Books が 0 件なら NDL に落とす', async () => {
  let ndlCalled = false;
  const result = await lookupBibliography(NO_OPENBD, { title: 'テスト本' }, {
    searchGoogleBooks: async () => [],
    searchNdl: async () => { ndlCalled = true; return [candidate('NDL の本')]; },
  });
  assert.equal(ndlCalled, true);
  assert.equal(result.warning, null);
  assert.deepEqual(result.candidates.map((c) => c.title), ['NDL の本']);
});

test('Google Books が返ったら NDL は叩かない', async () => {
  let ndlCalled = false;
  let googleFreeText = '';
  const result = await lookupBibliography(NO_OPENBD, { title: 'テスト本', author: 'テスト著者' }, {
    searchGoogleBooks: async (query) => {
      googleFreeText = query.freeText ?? '';
      return [candidate('Google の本', 'google_books')];
    },
    searchNdl: async () => { ndlCalled = true; return []; },
  });
  assert.equal(ndlCalled, false);
  assert.equal(googleFreeText, 'テスト本 テスト著者');
  assert.equal(result.warning, null);
  assert.deepEqual(result.candidates.map((c) => c.title), ['Google の本']);
});

test('全ソースが落ちても 候補 0 件 + 警告で返す (登録は止めない)', async () => {
  const result = await lookupBibliography(DEFAULT_BOOKS_CONFIG, { title: 'テスト' }, {
    searchGoogleBooks: async () => { throw new Error('offline'); },
    searchNdl: async () => { throw new Error('offline'); },
  });
  assert.deepEqual(result.candidates, []);
  assert.match(result.warning ?? '', /Google Books/);
  assert.match(result.warning ?? '', /NDL サーチ/);
});

test('openBD が落ちても素の候補は返す', async () => {
  const result = await lookupBibliography(DEFAULT_BOOKS_CONFIG, { title: 'テスト' }, {
    searchGoogleBooks: async () => [candidate('本', 'google_books')],
    enrichWithOpenBd: async () => { throw new Error('openbd down'); },
  });
  assert.deepEqual(result.candidates.map((c) => c.title), ['本']);
  assert.match(result.warning ?? '', /openBD/);
  assert.doesNotMatch(result.warning ?? '', /openbd down/);
});
