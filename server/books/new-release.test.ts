// 新刊判定のテスト。 ネットワークは触らず filterNewReleases だけを見る。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BOOKS_CONFIG } from './config.js';
import { filterNewReleases } from './new-release.js';
import type { BookCandidate, WatchTarget } from './types.js';

const NOW = new Date('2026-09-03T09:00:00+09:00');
const TARGET: WatchTarget = { kind: 'author', value: 'かわぐち かいじ', bookCount: 3, topRating: 5 };

function candidate(overrides: Partial<BookCandidate> = {}): BookCandidate {
  return {
    isbn13: null,
    title: '新刊タイトル',
    authors: ['かわぐち かいじ'],
    publisher: null,
    series: null,
    publishedOn: '2026-09-01',
    coverUrl: null,
    url: null,
    source: 'ndl',
    rating: null,
    ratingCount: null,
    salesRank: null,
    ...overrides,
  };
}

test('発売日が範囲内・未所持・著者一致のものだけ残る', () => {
  const result = filterNewReleases([
    candidate(),
    candidate({ title: '古い本', publishedOn: '2020-01-01' }),
    candidate({ title: '遠すぎる予約', publishedOn: '2030-01-01' }),
    candidate({ title: '日付不明' , publishedOn: null }),
    candidate({ title: '別人の本', authors: ['他の人'] }),
  ], TARGET, DEFAULT_BOOKS_CONFIG, new Set(), NOW);
  assert.deepEqual(result.map((c) => c.title), ['新刊タイトル']);
});

test('所持済み・重複タイトルは落ちる', () => {
  const owned = new Set(['もってる本']);
  const result = filterNewReleases([
    candidate({ title: 'もってる本' }),
    candidate({ title: '重複', publishedOn: '2026-09-02' }),
    candidate({ title: '重複', publishedOn: '2026-08-30' }),
  ], TARGET, DEFAULT_BOOKS_CONFIG, owned, NOW);
  assert.deepEqual(result.map((c) => c.title), ['重複']);
});

test('著者名の空白ゆれは同一視する', () => {
  const result = filterNewReleases(
    [candidate({ authors: ['かわぐちかいじ'] })],
    TARGET, DEFAULT_BOOKS_CONFIG, new Set(), NOW,
  );
  assert.equal(result.length, 1);
});

test('シリーズウォッチでは著者一致を要求しない', () => {
  const seriesTarget: WatchTarget = { kind: 'series', value: 'よくわかる指標', bookCount: 2, topRating: 4 };
  const result = filterNewReleases(
    [candidate({ title: 'よくわかる指標 5', authors: ['別の人'] })],
    seriesTarget, DEFAULT_BOOKS_CONFIG, new Set(), NOW,
  );
  assert.equal(result.length, 1);
});

test('日付範囲の両端を当日として含める', () => {
  const result = filterNewReleases([
    candidate({ title: '範囲の最古日', publishedOn: '2026-07-05' }),
    candidate({ title: '範囲の最新日', publishedOn: '2027-01-01' }),
  ], TARGET, DEFAULT_BOOKS_CONFIG, new Set(), NOW);
  assert.deepEqual(result.map((entry) => entry.title), ['範囲の最新日', '範囲の最古日']);
});
