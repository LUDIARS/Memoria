import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { DEFAULT_INTEREST_PREFS, matchedKeywords, normalizeScores, scoreInterest, trendStrength, type ClickStats, type InterestInput } from './interest.js';
import { clickStats, getInterestPrefs, interestPrefsSchema, pruneClicksBefore, recordClick, setInterestPrefs } from './interest-store.js';
import { buildTrendMap } from './map.js';
import { trendKey } from './movement.js';
import { ensureTrendCrawlerSchema } from './schema.js';
import type { TrendItemView, TrendOverview } from './types.js';

const NO_CLICKS: ClickStats = { total: 0, byGenre: new Map(), byKey: new Map() };

const input = (over: Partial<InterestInput> = {}): InterestInput => ({
  key: trendKey('話題'), title: '話題', genre: 'tech', rank: 1, itemsInSource: 10, movement: 'same', crossHit: false, ...over,
});

test('trendStrength は上位・新登場・複数サイト一致ほど強い', () => {
  assert.equal(trendStrength(input({ rank: 1 })), 1);
  assert.equal(trendStrength(input({ rank: 10 })), 0.5);
  assert.ok(trendStrength(input({ movement: 'new', crossHit: true })) > trendStrength(input({ movement: 'new' })));
});

test('ジャンルの興味と気になる言葉でスコアが上がり、 理由が付く', () => {
  const base = scoreInterest(input({ title: 'Gemini 4 の発表' }), DEFAULT_INTEREST_PREFS, NO_CLICKS);
  const prefs = { genreWeights: { tech: 2 }, keywords: ['gemini'] };
  const boosted = scoreInterest(input({ title: 'Gemini 4 の発表' }), prefs, NO_CLICKS);
  assert.ok(boosted.score > base.score * 3);
  assert.deepEqual(boosted.reasons, ['ジャンルの興味 ×2', '気になる言葉「gemini」']);
  assert.deepEqual(matchedKeywords('ＡＩエージェント特集', ['ai', 'ゲーム']), ['ai']);
});

test('ジャンルの興味が 0 でもスコアは 0 にならない (消えない)', () => {
  const zero = scoreInterest(input(), { genreWeights: { tech: 0 }, keywords: [] }, NO_CLICKS);
  assert.ok(zero.score > 0);
});

test('よく開くジャンルと開いた話題は大きくなる。 開いた回数が少ないうちはジャンル学習を効かせない', () => {
  const clicks: ClickStats = { total: 4, byGenre: new Map([['tech', 4]]), byKey: new Map([[trendKey('話題'), 1]]) };
  const learned = scoreInterest(input(), DEFAULT_INTEREST_PREFS, clicks);
  assert.ok(learned.reasons.includes('よく開くジャンル'));
  assert.ok(learned.reasons.includes('開いたことがある話題'));
  assert.ok(learned.score > scoreInterest(input(), DEFAULT_INTEREST_PREFS, NO_CLICKS).score);
  const few: ClickStats = { total: 2, byGenre: new Map([['tech', 2]]), byKey: new Map() };
  assert.equal(scoreInterest(input(), DEFAULT_INTEREST_PREFS, few).reasons.includes('よく開くジャンル'), false);
});

test('normalizeScores は 0〜1 に並べ、 全部同じなら 0.5', () => {
  assert.deepEqual(normalizeScores([1, 1]), [0.5, 0.5]);
  const out = normalizeScores([0.5, 1, 4]);
  assert.equal(out[0], 0);
  assert.equal(out[2], 1);
  assert.ok(out[1] > 0 && out[1] < 1);
  assert.deepEqual(normalizeScores([]), []);
});

function item(rank: number, title: string): TrendItemView {
  return { rank, title, subtitle: null, url: `https://example.com/${rank}`, metric: null, key: trendKey(title), firstSeenAt: null, movement: { status: 'same', delta: 0 } };
}

const overview: TrendOverview = {
  lastCrawledAt: '2026-10-14T00:00:00.000Z',
  summary: null,
  crossHits: [{ key: trendKey('共通'), title: '共通', sources: [] }],
  genres: [
    { genre: 'tech', label: 'テック', summary: null, sources: [{ sourceId: 'hn', name: 'HN', kind: 'hn_top', url: 'https://news.ycombinator.com', fetchedAt: null, error: null,
      items: [item(1, 'AI 新モデル'), item(2, '共通'), item(3, 'Rust')] }] },
    { genre: 'youth', label: '若者', summary: null, sources: [{ sourceId: 'gn', name: 'GN', kind: 'rss', url: 'https://news.google.com', fetchedAt: null, error: null,
      items: [item(1, '共通'), item(2, 'メロい')] }] },
  ],
};

test('buildTrendMap は同じ話題を 1 枚にまとめ、 興味の強い順に並べ、 最小の興味も残す', () => {
  const map = buildTrendMap(overview, { genreWeights: { youth: 3 }, keywords: [] }, NO_CLICKS, 8);
  assert.equal(map.tiles.length, 4);
  assert.equal(map.tiles.filter((t) => t.title === '共通').length, 1);
  assert.equal(map.tiles[0].genre, 'youth');
  assert.equal(map.tiles[0].interest, 1);
  assert.equal(map.tiles.at(-1)!.interest, 0);
  assert.ok(map.tiles.every((t) => t.interest >= 0 && t.interest <= 1));
  assert.deepEqual(map.genres.map((g) => [g.genre, g.weight, g.count]), [['tech', 1, 3], ['youth', 3, 1]]);
});

test('buildTrendMap は 1 ソースあたりの件数で切る', () => {
  assert.equal(buildTrendMap(overview, DEFAULT_INTEREST_PREFS, NO_CLICKS, 1).tiles.length, 2);
});

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
  ensureTrendCrawlerSchema(db);
  return db;
}

test('興味の設定は保存・読み込みでき、 重複した言葉は 1 つにまとまる', () => {
  const db = openDb();
  assert.deepEqual(getInterestPrefs(db), DEFAULT_INTEREST_PREFS);
  setInterestPrefs(db, { genreWeights: { music: 2 }, keywords: ['AI', 'AI', 'ゲーム'] });
  assert.deepEqual(getInterestPrefs(db), { genreWeights: { music: 2 }, keywords: ['AI', 'ゲーム'] });
  assert.equal(interestPrefsSchema.safeParse({ genreWeights: { music: 5 }, keywords: [] }).success, false);
  assert.equal(interestPrefsSchema.safeParse({ genreWeights: { unknown: 1 }, keywords: [] }).success, false);
});

test('開いた記録は期間内だけ数え、 古い記録は消せる', () => {
  const db = openDb();
  const now = new Date('2026-10-14T00:00:00Z');
  recordClick(db, { key: 'a', genre: 'tech', sourceId: 'hn' }, now);
  recordClick(db, { key: 'a', genre: 'tech', sourceId: 'hn' }, now);
  recordClick(db, { key: 'b', genre: 'music', sourceId: 'apple' }, new Date('2026-05-01T00:00:00Z'));
  const stats = clickStats(db, now);
  assert.equal(stats.total, 2);
  assert.equal(stats.byGenre.get('tech'), 2);
  assert.equal(stats.byKey.get('a'), 2);
  assert.equal(stats.byGenre.has('music'), false);
  assert.equal(pruneClicksBefore(db, '2026-07-01T00:00:00Z'), 1);
});
