import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anilistQuery, parseAnilistTrending } from './sources/anilist-source.js';
import { parseAppleTop } from './sources/apple-source.js';
import { fetchTrendSource } from './sources/fetch-source.js';
import { parseHnTopIds, toHnItems } from './sources/hackernews-source.js';
import { decodeXmlEntities, parseTrendFeed } from './sources/rss-source.js';
import { isTopicArticle, parseWikipediaTop, wikipediaTopUrl } from './sources/wikipedia-source.js';
import type { TrendSource } from './types.js';

const GOOGLE_TRENDS = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:ht="https://trends.google.com/trending/rss" version="2.0"><channel><title>Daily Search Trends</title>
<item><title>福原愛</title><ht:approx_traffic>1000+</ht:approx_traffic><link>https://trends.google.com/trending/rss?geo=JP</link>
<ht:news_item><ht:news_item_title>記事</ht:news_item_title><ht:news_item_url>https://news.example.jp/a</ht:news_item_url></ht:news_item></item>
<item><title>大宮エリー</title><ht:approx_traffic>500+</ht:approx_traffic><link>https://trends.google.com/trending/rss?geo=JP</link></item>
</channel></rss>`;

const HATENA_RDF = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:hatena="http://www.hatena.ne.jp/info/xmlns#">
<channel rdf:about="https://b.hatena.ne.jp/hotentry/game"><title>&#x306F;&#x3066;&#x306A;</title></channel>
<item rdf:about="https://example.com/1"><title>&#x30B2;&#x30FC;&#x30E0; &amp; &#x30A2;&#x30CB;&#x30E1;</title><link>https://example.com/1</link><hatena:bookmarkcount>321</hatena:bookmarkcount></item>
<item rdf:about="https://example.com/2"><title>二件目</title><link>https://example.com/2</link><hatena:bookmarkcount>12</hatena:bookmarkcount></item>
</rdf:RDF>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Top post</title><link rel="alternate" href="https://www.reddit.com/r/gaming/1"/></entry>
<entry><title><![CDATA[Second <b>post</b>]]></title><link href="https://www.reddit.com/r/gaming/2"/></entry>
</feed>`;

test('Google トレンドは検索数を指標にし、 URL は関連ニュースを使う', () => {
  const items = parseTrendFeed(GOOGLE_TRENDS, 10);
  assert.deepEqual(items.map((i) => [i.rank, i.title, i.metric, i.url]), [
    [1, '福原愛', '1000+ 検索', 'https://news.example.jp/a'],
    [2, '大宮エリー', '500+ 検索', null],
  ]);
});

test('はてブの RDF は数値文字参照を復号し、 ブックマーク数を指標にする', () => {
  const items = parseTrendFeed(HATENA_RDF, 10);
  assert.equal(items[0].title, 'ゲーム & アニメ');
  assert.equal(items[0].metric, '321 users');
  assert.equal(items[1].rank, 2);
});

test('Atom は alternate link と CDATA のタグ剥がしを扱い、 limit で切る', () => {
  const items = parseTrendFeed(ATOM, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://www.reddit.com/r/gaming/1');
  assert.equal(parseTrendFeed(ATOM, 5)[1].title, 'Second post');
});

test('RSS でも Atom でもない XML はエラーにする', () => {
  assert.throws(() => parseTrendFeed('<html><body/></html>', 5), /RSS \/ Atom/);
});

test('decodeXmlEntities は 1 回だけ復号する', () => {
  assert.equal(decodeXmlEntities('&amp;lt; &#65;&#x42;'), '&lt; AB');
});

test('Apple ランキングは曲名と補足 (アーティスト) を拾う', () => {
  const json = JSON.stringify({ feed: { results: [
    { name: '結び', artistName: 'Ayumu Imazu', url: 'https://music.apple.com/jp/album/1' },
    { name: '', artistName: 'x' },
    { name: '二曲目', url: 'javascript:alert(1)' },
  ] } });
  const items = parseAppleTop(json, 10);
  assert.deepEqual(items.map((i) => [i.rank, i.title, i.subtitle, i.url]), [
    [1, '結び', 'Ayumu Imazu', 'https://music.apple.com/jp/album/1'],
    [2, '二曲目', null, null],
  ]);
  assert.throws(() => parseAppleTop('{}', 5), /results/);
});

test('Wikipedia はメインページ・名前空間付きページを除き、 前日 (UTC) の URL を組む', () => {
  assert.equal(
    wikipediaTopUrl('https://ja.wikipedia.org', new Date('2026-10-14T01:00:00Z')),
    'https://wikimedia.org/api/rest_v1/metrics/pageviews/top/ja.wikipedia/all-access/2026/10/13',
  );
  assert.equal(isTopicArticle('特別:検索'), false);
  const json = JSON.stringify({ items: [{ articles: [
    { article: 'メインページ', views: 600000 },
    { article: '大宮エリー', views: 335210 },
    { article: '特別:検索', views: 75559 },
    { article: 'New_York', views: 1000 },
  ] }] });
  const items = parseWikipediaTop(json, 'https://ja.wikipedia.org', 10);
  assert.deepEqual(items.map((i) => [i.rank, i.title]), [[1, '大宮エリー'], [2, 'New York']]);
  assert.equal(items[0].url, `https://ja.wikipedia.org/wiki/${encodeURIComponent('大宮エリー')}`);
  assert.match(items[0].metric ?? '', /335,210 閲覧/);
});

test('AniList は日本語題を優先し、 GraphQL のエラーを伝える', () => {
  const body = JSON.parse(anilistQuery('MANGA', 99));
  assert.equal(body.variables.type, 'MANGA');
  assert.equal(body.variables.perPage, 50);
  const json = JSON.stringify({ data: { Page: { media: [
    { title: { native: '葬送のフリーレン', romaji: 'Sousou no Frieren', english: 'Frieren' }, siteUrl: 'https://anilist.co/anime/1', trending: 120 },
    { title: { romaji: 'Only Romaji' }, siteUrl: 'https://evil.example/x' },
  ] } } });
  const items = parseAnilistTrending(json, 10);
  assert.deepEqual(items.map((i) => [i.title, i.subtitle, i.url, i.metric]), [
    ['葬送のフリーレン', 'Frieren', 'https://anilist.co/anime/1', 'trend 120'],
    ['Only Romaji', null, null, null],
  ]);
  assert.throws(() => parseAnilistTrending(JSON.stringify({ errors: [{ message: 'Too Many Requests' }] }), 5), /Too Many Requests/);
});

test('Hacker News は取れた item だけを並び順で順位付けし、 URL が無ければ議論ページにする', () => {
  assert.deepEqual(parseHnTopIds('[3, 1, "x", 2]', 2), [3, 1]);
  const items = toHnItems([
    { id: 3, title: 'Show HN: X', url: 'https://x.example', score: 120, descendants: 30 },
    null,
    { id: 1, title: 'Ask HN: Y', score: 5 },
  ]);
  assert.deepEqual(items.map((i) => [i.rank, i.url, i.metric]), [
    [1, 'https://x.example', '120 points · 30 comments'],
    [2, 'https://news.ycombinator.com/item?id=1', '5 points'],
  ]);
});

test('fetchTrendSource は Wikipedia の前日分が 404 なら 1 日遡る', async () => {
  const source: TrendSource = { id: 'w', name: 'W', genre: 'general', kind: 'wikipedia_top', url: 'https://ja.wikipedia.org', enabled: true };
  const requested: string[] = [];
  const items = await fetchTrendSource(source, 5, {
    now: new Date('2026-10-14T01:00:00Z'),
    get: async (url) => {
      requested.push(url);
      if (url.endsWith('2026/10/13')) throw new Error('HTTP 404 Not Found');
      return JSON.stringify({ items: [{ articles: [{ article: 'A', views: 1 }] }] });
    },
  });
  assert.equal(items.length, 1);
  assert.deepEqual(requested.map((u) => u.slice(-10)), ['2026/10/13', '2026/10/12']);
});

test('fetchTrendSource は AniList を POST で取り、 HN は item を並列に取る', async () => {
  const anime: TrendSource = { id: 'a', name: 'A', genre: 'anime', kind: 'anilist_anime', url: 'https://anilist.co/search/anime/trending', enabled: true };
  const posted: string[] = [];
  await fetchTrendSource(anime, 3, {
    post: async (_url, body) => { posted.push(body); return JSON.stringify({ data: { Page: { media: [] } } }); },
  });
  assert.equal(JSON.parse(posted[0]).variables.type, 'ANIME');

  const hn: TrendSource = { id: 'h', name: 'H', genre: 'tech', kind: 'hn_top', url: 'https://news.ycombinator.com', enabled: true };
  const items = await fetchTrendSource(hn, 2, {
    get: async (url) => {
      if (url.endsWith('/topstories.json')) return '[10, 11, 12]';
      if (url.endsWith('/item/11.json')) throw new Error('HTTP 500');
      return JSON.stringify({ id: 10, title: 'Ten' });
    },
  });
  assert.deepEqual(items.map((i) => i.title), ['Ten']);
});
