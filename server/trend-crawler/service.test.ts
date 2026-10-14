import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { DEFAULT_TREND_CRAWLER_CONFIG, getTrendCrawlerConfig, withNewDefaultSources, getTrendSummary, setTrendCrawlerConfig, trendCrawlerConfigSchema } from './config.js';
import { buildTrendOverview } from './overview.js';
import { ensureTrendCrawlerSchema } from './schema.js';
import { shouldCrawlTrends } from './scheduler.js';
import { crawlTrends } from './service.js';
import { buildTrendSummaryPrompt, parseTrendSummary } from './summarizer.js';
import { DEFAULT_TREND_SOURCE_RELEASES } from './default-sources.js';
import type { RawTrendItem, TrendCrawlerConfig, TrendSource } from './types.js';

const SOURCES: TrendSource[] = [
  { id: 'google', name: 'Google', genre: 'general', kind: 'rss', url: 'https://trends.example/rss', enabled: true },
  { id: 'wiki', name: 'Wikipedia', genre: 'general', kind: 'wikipedia_top', url: 'https://ja.wikipedia.org', enabled: true },
  { id: 'off', name: 'Off', genre: 'tech', kind: 'rss', url: 'https://off.example/rss', enabled: false },
];

function openDb(config: Partial<TrendCrawlerConfig> = {}): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
  ensureTrendCrawlerSchema(db);
  setTrendCrawlerConfig(db, { ...DEFAULT_TREND_CRAWLER_CONFIG, sources: SOURCES, ...config });
  return db;
}

const items = (...titles: string[]): RawTrendItem[] => titles.map((title, index) => ({ rank: index + 1, title, subtitle: null, url: null, metric: null }));

const SUMMARY_JSON = '```json\n{"overall": "全体の流れ", "general": "総合の傾向", "tech": "不要"}\n```';

test('巡回は有効なソースだけ取得し、 前回との順位差と初登場を出す', async () => {
  const db = openDb();
  const lists: Record<string, RawTrendItem[][]> = {
    google: [items('A', 'B', 'C'), items('C', 'A', 'D')],
    wiki: [items('B'), items('B')],
  };
  const fetched: string[] = [];
  const fetchSource = async (source: TrendSource): Promise<RawTrendItem[]> => {
    fetched.push(source.id);
    return lists[source.id].shift()!;
  };
  await crawlTrends(db, new Date('2026-10-14T00:00:00Z'), { fetchSource, summarize: async () => SUMMARY_JSON });
  const first = buildTrendOverview(db, getTrendCrawlerConfig(db), null);
  assert.equal(first.genres[0].sources[0].items[0].movement.status, 'unknown');

  await crawlTrends(db, new Date('2026-10-14T03:00:00Z'), { fetchSource, summarize: async () => SUMMARY_JSON });
  assert.deepEqual(fetched, ['google', 'wiki', 'google', 'wiki']);
  const overview = buildTrendOverview(db, getTrendCrawlerConfig(db), getTrendSummary(db));
  assert.deepEqual(overview.genres.map((g) => g.genre), ['general']);
  const google = overview.genres[0].sources.find((s) => s.sourceId === 'google')!;
  assert.deepEqual(google.items.map((i) => [i.title, i.movement.status, i.movement.delta]), [
    ['C', 'up', 2], ['A', 'down', -1], ['D', 'new', null],
  ]);
  assert.equal(google.items[1].firstSeenAt, '2026-10-14T00:00:00.000Z');
  assert.equal(google.items[2].firstSeenAt, '2026-10-14T03:00:00.000Z');
  assert.equal(overview.lastCrawledAt, '2026-10-14T03:00:00.000Z');
  assert.equal(overview.genres[0].summary, '総合の傾向');
  assert.equal(overview.summary?.overall, '全体の流れ');
});

test('取得失敗は他のソースを止めず、 前回成功分を表示したまま error を載せる', async () => {
  const db = openDb({ summarize: false });
  await crawlTrends(db, new Date('2026-10-14T00:00:00Z'), { fetchSource: async () => items('A') });
  const result = await crawlTrends(db, new Date('2026-10-14T03:00:00Z'), {
    fetchSource: async (source) => { if (source.id === 'google') throw new Error('HTTP 503'); return items('B'); },
  });
  assert.equal(result.ok, 1);
  assert.deepEqual(result.failed, [{ sourceId: 'google', error: 'HTTP 503' }]);
  const google = buildTrendOverview(db, getTrendCrawlerConfig(db), null).genres[0].sources.find((s) => s.sourceId === 'google')!;
  assert.equal(google.error, 'HTTP 503');
  assert.deepEqual(google.items.map((i) => i.title), ['A']);
  assert.equal(google.fetchedAt, '2026-10-14T00:00:00.000Z');
});

test('空の一覧は失敗として扱い、 itemsPerSource で切る', async () => {
  const db = openDb({ summarize: false, itemsPerSource: 2 });
  const result = await crawlTrends(db, new Date('2026-10-14T00:00:00Z'), {
    fetchSource: async (source) => source.id === 'google' ? items('A', 'B', 'C') : [],
  });
  assert.deepEqual(result.failed.map((f) => f.sourceId), ['wiki']);
  const google = buildTrendOverview(db, getTrendCrawlerConfig(db), null).genres[0].sources[0];
  assert.equal(google.items.length, 2);
});

test('保持日数より古い履歴は巡回のたびに消える', async () => {
  const db = openDb({ summarize: false, retentionDays: 1 });
  await crawlTrends(db, new Date('2026-10-01T00:00:00Z'), { fetchSource: async () => items('Old') });
  await crawlTrends(db, new Date('2026-10-14T00:00:00Z'), { fetchSource: async () => items('New') });
  const count = (db.prepare('SELECT COUNT(*) AS n FROM trend_snapshots').get() as { n: number }).n;
  assert.equal(count, 2);
  const itemsLeft = (db.prepare('SELECT COUNT(*) AS n FROM trend_items').get() as { n: number }).n;
  assert.equal(itemsLeft, 2);
});

test('1 ソースだけの更新と、 要約が壊れたときは前回の要約を残す', async () => {
  const db = openDb();
  await crawlTrends(db, new Date('2026-10-14T00:00:00Z'), { fetchSource: async () => items('A'), summarize: async () => SUMMARY_JSON });
  let summarized = 0;
  await crawlTrends(db, new Date('2026-10-14T01:00:00Z'), {
    fetchSource: async () => items('B'), summarize: async () => { summarized += 1; return SUMMARY_JSON; },
  }, 'google');
  assert.equal(summarized, 0);
  const result = await crawlTrends(db, new Date('2026-10-14T02:00:00Z'), { fetchSource: async () => items('C'), summarize: async () => 'not json' });
  assert.match(result.summaryError ?? '', /JSON/);
  assert.equal(getTrendSummary(db)?.overall, '全体の流れ');
});

test('要約プロンプトは新登場と急上昇に印を付け、 出力 JSON のキーを指定する', () => {
  const prompt = buildTrendSummaryPrompt([{
    genre: 'general', label: '総合', summary: null,
    sources: [{
      sourceId: 'g', name: 'Google', kind: 'rss', url: 'https://x', fetchedAt: null, error: null,
      items: [
        { rank: 1, title: 'A', subtitle: null, url: null, metric: '1000+ 検索', key: 'a', firstSeenAt: null, movement: { status: 'new', delta: null } },
        { rank: 2, title: 'B', subtitle: 'b', url: null, metric: null, key: 'b', firstSeenAt: null, movement: { status: 'up', delta: 7 } },
      ],
    }],
  }]);
  assert.match(prompt, /A \(1000\+ 検索\) \[新登場\]/);
  assert.match(prompt, /B \/ b \[↑7\]/);
  assert.match(prompt, /"overall"/);
  assert.match(prompt, /"general"/);
  const summary = parseTrendSummary('前置き {"overall":" x ","general":"","news":"n","unknown":"u"} 後書き', new Date('2026-10-14T00:00:00Z'));
  assert.deepEqual(summary, { generatedAt: '2026-10-14T00:00:00.000Z', overall: 'x', genres: { news: 'n' } });
});

test('shouldCrawlTrends は巡回間隔と直前の試行を見る', () => {
  const config = { ...DEFAULT_TREND_CRAWLER_CONFIG, intervalHours: 3 };
  const now = new Date('2026-10-14T06:00:00Z');
  assert.equal(shouldCrawlTrends(config, null, now, 0), true);
  assert.equal(shouldCrawlTrends(config, '2026-10-14T04:00:00Z', now, 0), false);
  assert.equal(shouldCrawlTrends(config, '2026-10-14T03:00:00Z', now, 0), true);
  assert.equal(shouldCrawlTrends(config, null, now, now.getTime() - 10 * 60_000), false);
  assert.equal(shouldCrawlTrends({ ...config, enabled: false }, null, now, 0), false);
});

test('設定スキーマは既定値を通し、 重複 id と種類に合わない URL を弾く', () => {
  assert.equal(trendCrawlerConfigSchema.safeParse(DEFAULT_TREND_CRAWLER_CONFIG).success, true);
  const dup = { ...DEFAULT_TREND_CRAWLER_CONFIG, sources: [SOURCES[0], SOURCES[0]] };
  assert.equal(trendCrawlerConfigSchema.safeParse(dup).success, false);
  const badApple = { ...DEFAULT_TREND_CRAWLER_CONFIG, sources: [{ ...SOURCES[0], kind: 'apple_top' }] };
  assert.equal(trendCrawlerConfigSchema.safeParse(badApple).success, false);
  const badWiki = { ...DEFAULT_TREND_CRAWLER_CONFIG, sources: [{ ...SOURCES[1], url: 'https://example.com' }] };
  assert.equal(trendCrawlerConfigSchema.safeParse(badWiki).success, false);
});

test('保存済み設定には、 その版より後に加わった既定ソースだけを足す', () => {
  const v1 = DEFAULT_TREND_SOURCE_RELEASES.find((release) => release.version === 1)!.sources;
  const youthIds = DEFAULT_TREND_SOURCE_RELEASES.find((release) => release.version === 2)!.sources.map((s) => s.id);
  // 版 1 で保存し、 その後 利用者が google-trends-jp を消した設定。
  const saved: TrendCrawlerConfig = { ...DEFAULT_TREND_CRAWLER_CONFIG, defaultsVersion: 1, sources: v1.filter((s) => s.id !== 'google-trends-jp') };
  const merged = withNewDefaultSources(saved);
  assert.equal(merged.defaultsVersion, DEFAULT_TREND_CRAWLER_CONFIG.defaultsVersion);
  assert.equal(merged.sources.some((s) => s.id === 'google-trends-jp'), false);
  assert.deepEqual(merged.sources.filter((s) => s.genre === 'youth').map((s) => s.id), youthIds);
  // 既に最新版なら何も足さない (利用者が若者ソースを消していても戻さない)。
  const latest = { ...merged, sources: merged.sources.filter((s) => s.genre !== 'youth') };
  assert.equal(withNewDefaultSources(latest).sources.some((s) => s.genre === 'youth'), false);
});

test('読み込み時に版 1 の保存設定へ若者ジャンルが加わる', () => {
  const db = openDb();
  db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(
    JSON.stringify({ ...DEFAULT_TREND_CRAWLER_CONFIG, defaultsVersion: 1, sources: SOURCES }), 'trend_crawler.config',
  );
  const config = getTrendCrawlerConfig(db);
  assert.equal(config.sources.length, SOURCES.length + DEFAULT_TREND_SOURCE_RELEASES[1].sources.length);
  assert.equal(trendCrawlerConfigSchema.safeParse(config).success, true);
});
