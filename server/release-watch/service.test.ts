import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReleaseCrawlCoordinator } from './coordinator.js';
import { shouldRefreshReleases } from './scheduler.js';
import { buildReleaseDigest, refreshSource } from './service.js';
import { DEFAULT_RELEASE_WATCH_CONFIG } from './config.js';
import type { RawRelease, ReleaseSource, ReleaseSourceDigest, ReleaseWatchConfig } from './types.js';

const now = new Date('2026-08-22T09:00:00+09:00');
const source: ReleaseSource = {
  id: 'claude-code', name: 'Claude Code', kind: 'github_releases', url: 'https://github.com/anthropics/claude-code',
  notesUrlTemplate: null, includePattern: null, enabled: true,
};
const raw = (v: string): RawRelease => ({ version: v, url: `https://github.com/anthropics/claude-code/releases/tag/${v}`, publishedAt: null, body: `changes of ${v}` });

test('要約は前回 digest に同じ version があれば再利用し、 新規分だけ LLM に掛ける', async () => {
  const previous: ReleaseSourceDigest = {
    sourceId: 'claude-code', sourceName: 'Claude Code', sourceKind: 'github_releases', url: source.url,
    fetchedAt: '2026-08-21T00:00:00Z', error: null,
    entries: [{ version: 'v2.1.0', url: 'u', publishedAt: null, summaryJa: '- 既存要約', summarizedAt: '2026-08-21T00:00:00Z' }],
  };
  const summarized: string[] = [];
  const out = await refreshSource(source, 5, previous, now, {
    fetchReleases: async () => [raw('v2.2.0'), raw('v2.1.0')],
    summarize: async (prompt) => { summarized.push(prompt); return '- 新しい要約'; },
  });
  assert.equal(summarized.length, 1);
  assert.match(summarized[0], /v2\.2\.0/);
  assert.deepEqual(out.entries.map((e) => [e.version, e.summaryJa]), [['v2.2.0', '- 新しい要約'], ['v2.1.0', '- 既存要約']]);
  assert.equal(out.error, null);
});

test('取得失敗時は前回の entries を残して error だけ載せる', async () => {
  const previous: ReleaseSourceDigest = {
    sourceId: 'claude-code', sourceName: 'Claude Code', sourceKind: 'github_releases', url: source.url,
    fetchedAt: '2026-08-21T00:00:00Z', error: null,
    entries: [{ version: 'v2.1.0', url: 'u', publishedAt: null, summaryJa: 's', summarizedAt: 't' }],
  };
  const out = await refreshSource(source, 5, previous, now, {
    fetchReleases: async () => { throw new Error('HTTP 503'); },
    summarize: async () => { throw new Error('must not be called'); },
  });
  assert.equal(out.entries.length, 1);
  assert.equal(out.error, 'HTTP 503');
});

test('本文が空の版は LLM を呼ばず固定文にする', async () => {
  let called = 0;
  const out = await refreshSource(source, 5, null, now, {
    fetchReleases: async () => [{ ...raw('v1'), body: '   ' }],
    summarize: async () => { called += 1; return 'x'; },
  });
  assert.equal(called, 0);
  assert.match(out.entries[0].summaryJa, /取得できなかった/);
});

test('buildReleaseDigest は無効ソースと対象外ソースを前回結果のまま持ち越す', async () => {
  const config: ReleaseWatchConfig = {
    ...DEFAULT_RELEASE_WATCH_CONFIG,
    versionsPerSource: 2,
    sources: [source, { ...source, id: 'git', name: 'Git', enabled: false }],
  };
  const previous = {
    date: '2026-08-21', generatedAt: 'g',
    sources: [{ sourceId: 'git', sourceName: 'Git', sourceKind: 'github_releases' as const, url: source.url, fetchedAt: 'f', error: null, entries: [] }],
  };
  const digest = await buildReleaseDigest(config, previous, now, {
    fetchReleases: async () => [raw('a'), raw('b'), raw('c')],
    summarize: async () => '- ok',
  });
  assert.equal(digest.date, '2026-08-22');
  assert.deepEqual(digest.sources.map((s) => s.sourceId), ['claude-code', 'git']);
  assert.equal(digest.sources[0].entries.length, 2);
  assert.equal(digest.sources[1].fetchedAt, 'f');
});

test('1 ソースだけの更新は digest の date を進めず、 当日の全体巡回を止めない', async () => {
  const config: ReleaseWatchConfig = {
    ...DEFAULT_RELEASE_WATCH_CONFIG,
    refreshHour: 6,
    sources: [source, { ...source, id: 'git', name: 'Git' }],
  };
  const previous = {
    date: '2026-08-21', generatedAt: 'g',
    sources: [{ sourceId: 'git', sourceName: 'Git', sourceKind: 'github_releases' as const, url: source.url, fetchedAt: 'f', error: null, entries: [] }],
  };
  const deps = { fetchReleases: async () => [raw('v1')], summarize: async () => '- ok' };
  // localDate / getHours はどちらも実行環境の TZ で評価されるので、 ローカル時刻で組む。
  const localNow = new Date(2026, 7, 22, 9, 0, 0);

  const single = await buildReleaseDigest(config, previous, localNow, deps, 'claude-code');
  assert.equal(single.date, '2026-08-21', '個別更新で当日の日付を立ててはいけない');
  assert.equal(shouldRefreshReleases(config, single.date, localNow, 0), true, '残りのソースは当日まだ巡回されるべき');

  // 前回 digest が無い状態での個別更新も、 全体巡回を止めない。
  const fresh = await buildReleaseDigest(config, null, localNow, deps, 'claude-code');
  assert.equal(fresh.date, null);
  assert.equal(shouldRefreshReleases(config, fresh.date, localNow, 0), true);

  // 全ソース巡回のときだけ date が当日に進む。
  const full = await buildReleaseDigest(config, previous, localNow, deps);
  assert.equal(full.date, '2026-08-22');
  assert.equal(shouldRefreshReleases(config, full.date, localNow, 0), false);
});

test('スケジューラは巡回時刻以降・当日未取得・30 分リトライ間隔で 1 回だけ発火する', () => {
  const config = { ...DEFAULT_RELEASE_WATCH_CONFIG, refreshHour: 6 };
  const at = (h: number): Date => new Date(2026, 7, 22, h, 0, 0);
  assert.equal(shouldRefreshReleases(config, null, at(5), 0), false);
  assert.equal(shouldRefreshReleases(config, null, at(6), 0), true);
  assert.equal(shouldRefreshReleases(config, '2026-08-22', at(7), 0), false);
  assert.equal(shouldRefreshReleases(config, '2026-08-21', at(7), at(7).getTime() - 10 * 60 * 1000), false);
  assert.equal(shouldRefreshReleases({ ...config, enabled: false }, null, at(7), 0), false);
});

test('coordinator は同時に 1 本だけ走らせる', async () => {
  const coordinator = new ReleaseCrawlCoordinator();
  let release!: () => void;
  const first = coordinator.request(() => new Promise((resolve) => { release = () => resolve({ date: 'd', generatedAt: 'g', sources: [] }); }));
  assert.equal(first.status, 'started');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(coordinator.request(async () => ({ date: 'd', generatedAt: 'g', sources: [] })).status, 'busy');
  release();
  if (first.status === 'started') await first.promise;
  assert.equal(coordinator.busy, false);
});
