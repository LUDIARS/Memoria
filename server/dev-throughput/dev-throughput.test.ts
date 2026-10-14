import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { Hono } from 'hono';
import { collectDevThroughput, daysNeedingCommitCount } from './collect.js';
import { countMergesByDay } from './count-merges.js';
import { countCommitsOnDay, GithubRateLimitError } from './github-commit-count.js';
import { jstDayOf, jstDayRange, recentJstDays } from './jst-day.js';
import { fetchMergedPullRequests } from './revisor-merges.js';
import { createDevThroughput, parseViewDays } from './router.js';
import { ensureDevThroughputSchema, listDaily, saveCommitCount, saveMergeCount } from './store.js';
import { DevThroughputSyncCoordinator } from './sync-coordinator.js';
import type { DailyThroughput, MergeCount } from './types.js';

// 2026-10-14 20:30 JST
const NOW = new Date('2026-10-14T11:30:00.000Z');

test('JST の暦日: UTC 15:00 で日付が変わり、 直近の日を新しい順に返す', () => {
  assert.equal(jstDayOf('2026-10-13T14:59:59.000Z'), '2026-10-13');
  assert.equal(jstDayOf('2026-10-13T15:00:00.000Z'), '2026-10-14');
  assert.equal(jstDayOf('not a date'), null);
  assert.deepEqual(recentJstDays(NOW, 3), ['2026-10-14', '2026-10-13', '2026-10-12']);
  assert.equal(jstDayRange('2026-10-14'), '2026-10-14T00:00:00+09:00..2026-10-14T23:59:59+09:00');
  assert.throws(() => jstDayRange('2026/10/14'), /invalid day/);
});

test('マージ件数はマージ済みだけを JST の日とリポで数え、 対象外の日は捨てる', () => {
  const counts = countMergesByDay([
    { repository: 'LUDIARS/Memoria', status: 'merged', updatedAt: '2026-10-14T01:00:00.000Z' },
    { repository: 'LUDIARS/Memoria', status: 'merged', updatedAt: '2026-10-13T15:30:00.000Z' },
    { repository: 'LUDIARS/Ergo', status: 'merged', updatedAt: '2026-10-13T03:00:00.000Z' },
    { repository: 'LUDIARS/Ergo', status: 'closed', updatedAt: '2026-10-14T03:00:00.000Z' },
    { repository: 'LUDIARS/Ergo', status: 'merged', updatedAt: '2026-09-01T03:00:00.000Z' },
  ], ['2026-10-14', '2026-10-13']);
  assert.deepEqual(counts.get('2026-10-14'), { total: 2, byRepo: { 'LUDIARS/Memoria': 2 } });
  assert.deepEqual(counts.get('2026-10-13'), { total: 1, byRepo: { 'LUDIARS/Ergo': 1 } });
});

test('Revisor の一覧は summary/merged で読み、 形の違う行は捨てる。 接続先が無ければ失敗する', async () => {
  const requested: string[] = [];
  const list = await fetchMergedPullRequests({
    baseUrl: 'http://127.0.0.1:4240/',
    fetchImpl: async (url) => {
      requested.push(url);
      return new Response(JSON.stringify({ pullRequests: [{ repository: 'LUDIARS/Mm', status: 'merged', updatedAt: '2026-10-14T00:00:00Z', title: 'x' }, { repository: 1 }] }));
    },
  });
  assert.deepEqual(requested, ['http://127.0.0.1:4240/v1/local-prs?view=summary&state=merged']);
  assert.deepEqual(list, [{ repository: 'LUDIARS/Mm', status: 'merged', updatedAt: '2026-10-14T00:00:00Z' }]);
  await assert.rejects(fetchMergedPullRequests({ baseUrl: undefined }), /REVISOR_URL/);
  await assert.rejects(fetchMergedPullRequests({ baseUrl: 'http://127.0.0.1:4240', fetchImpl: async () => new Response('', { status: 500 }) }), /500/);
});

test('コミット件数は org と JST の 1 日で検索し total_count を返す。 上限は専用の失敗にする', async () => {
  let seen: { url: string; auth?: string } | null = null;
  const count = await countCommitsOnDay('2026-10-14', {
    org: 'LUDIARS', token: 't0ken',
    fetchImpl: async (url, init) => { seen = { url, auth: init.headers?.Authorization }; return new Response(JSON.stringify({ total_count: 103, incomplete_results: false })); },
  });
  assert.equal(count, 103);
  assert.equal(seen!.auth, 'Bearer t0ken');
  assert.equal(new URL(seen!.url).searchParams.get('q'), 'org:LUDIARS committer-date:2026-10-14T00:00:00+09:00..2026-10-14T23:59:59+09:00');
  await assert.rejects(countCommitsOnDay('2026-10-14', { org: 'LUDIARS', token: null, fetchImpl: async () => new Response('', { status: 403 }) }), GithubRateLimitError);
  await assert.rejects(countCommitsOnDay('2026-10-14', { org: 'LUDIARS', token: null, fetchImpl: async () => new Response(JSON.stringify({ total_count: 5, incomplete_results: true })) }), /打ち切られ/);
});

test('保存はマージとコミットを別々に上書きし、 一覧は指定順で行のある日だけ返す', () => {
  const db = new Database(':memory:');
  ensureDevThroughputSchema(db);
  saveMergeCount(db, '2026-10-14', { total: 3, byRepo: { 'LUDIARS/Mm': 3 } }, 'a');
  saveCommitCount(db, '2026-10-14', 10, 'b');
  saveCommitCount(db, '2026-10-13', 7, 'c');
  saveMergeCount(db, '2026-10-14', { total: 4, byRepo: { 'LUDIARS/Mm': 4 } }, 'd');
  assert.deepEqual(listDaily(db, ['2026-10-14', '2026-10-12', '2026-10-13']), [
    { day: '2026-10-14', rvMerged: 4, rvByRepo: { 'LUDIARS/Mm': 4 }, commits: 10, collectedAt: 'd' },
    { day: '2026-10-13', rvMerged: 0, rvByRepo: {}, commits: 7, collectedAt: 'c' },
  ]);
});

function memoryStore() {
  const merges = new Map<string, MergeCount>();
  const commits = new Map<string, number>();
  return {
    merges, commits,
    listDaily: (days: readonly string[]): DailyThroughput[] => days.filter((d) => commits.has(d)).map((day) => ({ day, rvMerged: 0, rvByRepo: {}, commits: commits.get(day)!, collectedAt: '' })),
    saveMergeCount: (day: string, count: MergeCount) => { merges.set(day, count); },
    saveCommitCount: (day: string, value: number) => { commits.set(day, value); },
  };
}

test('コミット件数を聞き直すのは直近 2 日と未集計の日だけ', () => {
  const stored = ['2026-10-14', '2026-10-13', '2026-10-12'].map((day) => ({ day, rvMerged: 0, rvByRepo: {}, commits: 1, collectedAt: '' }));
  assert.deepEqual(daysNeedingCommitCount(['2026-10-14', '2026-10-13', '2026-10-12', '2026-10-11'], stored), ['2026-10-14', '2026-10-13', '2026-10-11']);
});

test('収集: Revisor が落ちてもコミットは保存し、 GitHub の上限で残りを次回へ回す', async () => {
  const store = memoryStore();
  const asked: string[] = [];
  const result = await collectDevThroughput({
    now: () => NOW, days: 4,
    fetchMerged: async () => { throw new Error('ECONNREFUSED'); },
    countCommits: async (day) => { asked.push(day); if (asked.length === 3) throw new GithubRateLimitError('limit'); return 5; },
    ...store,
    pause: async () => {},
  });
  assert.equal(result.mergeDays, 0);
  assert.equal(result.commitDays, 2);
  assert.deepEqual(asked, ['2026-10-14', '2026-10-13', '2026-10-12']);
  assert.match(result.errors.join('|'), /Revisor: ECONNREFUSED/);
  assert.match(result.errors.join('|'), /GitHub 2026-10-12: limit/);
});

test('収集: マージ件数は対象の全日を 0 も含めて上書きする', async () => {
  const store = memoryStore();
  await collectDevThroughput({
    now: () => NOW, days: 2,
    fetchMerged: async () => [{ repository: 'LUDIARS/Mm', status: 'merged', updatedAt: '2026-10-14T00:00:00Z' }],
    countCommits: async () => 1,
    ...store,
    pause: async () => {},
  });
  assert.deepEqual(store.merges.get('2026-10-14'), { total: 1, byRepo: { 'LUDIARS/Mm': 1 } });
  assert.deepEqual(store.merges.get('2026-10-13'), { total: 0, byRepo: {} });
});

test('同期は同時に 1 本だけ走り、 失敗は状態に残す', async () => {
  let release: () => void = () => {};
  let runs = 0;
  const coordinator = new DevThroughputSyncCoordinator(() => { runs += 1; return new Promise((resolve) => { release = () => resolve({ mergeDays: 0, commitDays: 0, errors: ['GitHub x: boom'] }); }); }, () => NOW);
  assert.equal(coordinator.start().running, true);
  coordinator.start();
  assert.equal(runs, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(coordinator.status(), { running: false, lastStartedAt: NOW.toISOString(), lastFinishedAt: NOW.toISOString(), lastError: 'GitHub x: boom' });
});

function requestFrom(app: Hono, address: string, url: string, method = 'GET'): Promise<Response> {
  return Promise.resolve(app.request(url, { method }, {
    incoming: { socket: { remoteAddress: address, remotePort: 12345, remoteFamily: 'IPv4' } },
  }));
}

test('API: 同じ端末からだけ使え、 直近 N 日を新しい順に未集計は null で返す', async () => {
  const db = new Database(':memory:');
  const { router } = createDevThroughput({ db, now: () => NOW, githubToken: () => null, revisorUrl: 'http://127.0.0.1:4240' });
  saveMergeCount(db, '2026-10-14', { total: 2, byRepo: { 'LUDIARS/Mm': 2 } }, 'x');
  saveCommitCount(db, '2026-10-14', 9, 'x');
  assert.equal((await requestFrom(router, '192.168.1.25', 'http://localhost/api/dev-throughput')).status, 403);
  const response = await requestFrom(router, '127.0.0.1', 'http://localhost/api/dev-throughput?days=2');
  assert.equal(response.status, 200);
  const body = await response.json() as { days: unknown[]; sync: { running: boolean } };
  assert.deepEqual(body.days, [
    { day: '2026-10-14', rvMerged: 2, rvByRepo: { 'LUDIARS/Mm': 2 }, commits: 9 },
    { day: '2026-10-13', rvMerged: null, rvByRepo: {}, commits: null },
  ]);
  assert.equal(body.sync.running, false);
  assert.equal(parseViewDays(undefined), 30);
  assert.equal(parseViewDays('500'), 90);
  assert.equal(parseViewDays('-1'), 30);
});
