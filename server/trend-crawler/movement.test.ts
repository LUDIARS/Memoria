import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCrossHits, movementOf, rankMap, trendKey } from './movement.js';

test('trendKey は全角/半角・大小文字・空白と記号の差を畳む', () => {
  assert.equal(trendKey('ＡＩ エージェント！'), trendKey('ai-エージェント'));
  assert.notEqual(trendKey('福原愛'), trendKey('福原'));
});

test('movementOf: 初回は unknown、 前回に無ければ new、 あれば順位差', () => {
  assert.deepEqual(movementOf(1, 'a', null), { status: 'unknown', delta: null });
  const previous = new Map([['a', 5], ['b', 2], ['c', 3]]);
  assert.deepEqual(movementOf(1, 'x', previous), { status: 'new', delta: null });
  assert.deepEqual(movementOf(1, 'a', previous), { status: 'up', delta: 4 });
  assert.deepEqual(movementOf(4, 'b', previous), { status: 'down', delta: -2 });
  assert.deepEqual(movementOf(3, 'c', previous), { status: 'same', delta: 0 });
});

test('rankMap は同じ話題が重複したら最上位を採る', () => {
  const map = rankMap([{ rank: 3, title: 'A' }, { rank: 1, title: 'a' }]);
  assert.equal(map.get(trendKey('A')), 1);
});

test('findCrossHits は 2 ソース以上に出た話題だけを、 ソース数 → 最高順位の順で返す', () => {
  const hits = findCrossHits([
    { sourceId: 'g', site: 'trends.google.co.jp', name: 'Google', genre: 'general', items: [{ rank: 1, title: '福原愛' }, { rank: 2, title: '新垣結衣' }, { rank: 3, title: 'X' }] },
    { sourceId: 'w', site: 'ja.wikipedia.org', name: 'Wikipedia', genre: 'general', items: [{ rank: 4, title: '新垣結衣' }, { rank: 5, title: '福原 愛' }] },
    { sourceId: 'h', site: 'b.hatena.ne.jp', name: 'はてブ', genre: 'news', items: [{ rank: 9, title: '新垣結衣' }, { rank: 10, title: 'X' }] },
  ]);
  assert.deepEqual(hits.map((h) => [h.title, h.sources.length]), [['新垣結衣', 3], ['福原愛', 2]]);
});

test('findCrossHits は 1 文字のキーと同一ソース内の重複を数えない', () => {
  const hits = findCrossHits([
    { sourceId: 'a', site: 'a.example', name: 'A', genre: 'general', items: [{ rank: 1, title: 'Z' }, { rank: 2, title: 'Same' }, { rank: 3, title: 'same' }] },
    { sourceId: 'b', site: 'b.example', name: 'B', genre: 'general', items: [{ rank: 1, title: 'Z' }] },
  ]);
  assert.equal(hits.length, 0);
});

test('findCrossHits は同じサイトのカテゴリ違いだけの重複を数えない', () => {
  const hits = findCrossHits([
    { sourceId: 'hatena-all', site: 'b.hatena.ne.jp', name: 'はてブ 総合', genre: 'general', items: [{ rank: 1, title: '同じ記事' }, { rank: 2, title: '広がった話題' }] },
    { sourceId: 'hatena-life', site: 'b.hatena.ne.jp', name: 'はてブ 暮らし', genre: 'life', items: [{ rank: 1, title: '同じ記事' }, { rank: 3, title: '広がった話題' }] },
    { sourceId: 'wiki', site: 'ja.wikipedia.org', name: 'Wikipedia', genre: 'general', items: [{ rank: 4, title: '広がった話題' }] },
  ]);
  assert.deepEqual(hits.map((h) => [h.title, h.sources.length]), [['広がった話題', 3]]);
});
