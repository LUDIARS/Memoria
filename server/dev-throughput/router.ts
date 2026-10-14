// 開発量の日次集計 (Revisor のマージ件数・GitHub のコミット件数) の HTTP 口と組み立て。
// GET  /api/dev-throughput?days=30  直近 N 日 (新しい順、 最大 90)。 未集計の日は件数 null。
// POST /api/dev-throughput/sync     今すぐ集め直す (完了は待たない)。

import { Hono, type MiddlewareHandler } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import { isSameMachineRequest } from '../lib/local-request.js';
import { collectDevThroughput } from './collect.js';
import { countCommitsOnDay } from './github-commit-count.js';
import { resolveGithubToken } from './github-token.js';
import { recentJstDays } from './jst-day.js';
import { fetchMergedPullRequests, type FetchLike } from './revisor-merges.js';
import { ensureDevThroughputSchema, listDaily, saveCommitCount, saveMergeCount } from './store.js';
import { DevThroughputSyncCoordinator } from './sync-coordinator.js';

type Db = BetterSqlite3.Database;

export const COLLECT_DAYS = 30;
export const MAX_VIEW_DAYS = 90;
export const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const GITHUB_SEARCH_GAP_MS = 2_500;

export interface DailyView {
  day: string;
  rvMerged: number | null;
  rvByRepo: Record<string, number>;
  commits: number | null;
}

export interface DevThroughputDeps {
  db: Db;
  revisorUrl?: string;
  githubOrg?: string;
  fetchImpl?: FetchLike;
  githubToken?: () => string | null;
  now?: () => Date;
  pause?: () => Promise<void>;
}

export function parseViewDays(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return COLLECT_DAYS;
  return Math.min(parsed, MAX_VIEW_DAYS);
}

export function dailyView(db: Db, days: readonly string[]): DailyView[] {
  const stored = new Map(listDaily(db, days).map((row) => [row.day, row]));
  return days.map((day) => {
    const row = stored.get(day);
    return row
      ? { day, rvMerged: row.rvMerged, rvByRepo: row.rvByRepo, commits: row.commits }
      : { day, rvMerged: null, rvByRepo: {}, commits: null };
  });
}

export function createDevThroughput(deps: DevThroughputDeps): { router: Hono; coordinator: DevThroughputSyncCoordinator } {
  const { db } = deps;
  ensureDevThroughputSchema(db);
  const now = deps.now ?? (() => new Date());
  let token: string | null | undefined;
  const githubToken = () => (token === undefined ? (token = (deps.githubToken ?? resolveGithubToken)()) : token);

  const coordinator = new DevThroughputSyncCoordinator(() => collectDevThroughput({
    now,
    days: COLLECT_DAYS,
    fetchMerged: () => fetchMergedPullRequests({ baseUrl: deps.revisorUrl ?? process.env.REVISOR_URL, fetchImpl: deps.fetchImpl }),
    countCommits: (day) => countCommitsOnDay(day, {
      org: deps.githubOrg ?? process.env.DEV_THROUGHPUT_GITHUB_ORG ?? 'LUDIARS',
      token: githubToken(),
      fetchImpl: deps.fetchImpl,
    }),
    listDaily: (days) => listDaily(db, days),
    saveMergeCount: (day, count, at) => saveMergeCount(db, day, count, at),
    saveCommitCount: (day, commits, at) => saveCommitCount(db, day, commits, at),
    pause: deps.pause ?? (() => new Promise((resolve) => setTimeout(resolve, GITHUB_SEARCH_GAP_MS))),
  }), now);

  const router = new Hono();
  const guard: MiddlewareHandler = async (context, next) => {
    context.header('Cache-Control', 'no-store');
    if (!isSameMachineRequest(context)) return context.json({ error: 'same-machine access required' }, 403);
    await next();
  };
  router.use('/api/dev-throughput', guard);
  router.use('/api/dev-throughput/*', guard);
  router.get('/api/dev-throughput', (context) => {
    const days = recentJstDays(now(), parseViewDays(context.req.query('days')));
    return context.json({ days: dailyView(db, days), sync: coordinator.status() });
  });
  router.post('/api/dev-throughput/sync', (context) => context.json(coordinator.start(), 202));
  return { router, coordinator };
}
