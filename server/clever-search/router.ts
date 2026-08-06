import { performance } from 'node:perf_hooks';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  CleverSearchHistoryResponse,
  CleverSearchRequest,
  CleverSearchResponse,
} from '../api/types/clever-search.js';
import { isSameMachineRequest } from '../lib/local-request.js';
import { buildCleverSearchReport } from './report.js';
import { ensureCleverSearchSchema } from './schema.js';
import {
  findCachedCleverSearchReport,
  getCleverSearchReport,
  listCleverSearchReports,
  normalizeCleverSearchQuery,
  parseStoredCleverSearchReport,
  saveCleverSearchReport,
  searchCleverDocuments,
} from './store.js';

type Db = BetterSqlite3.Database;

export interface CleverSearchRouterDeps {
  db: Db;
  now?: () => Date;
  random?: () => number;
}

const NO_STORE = { 'Cache-Control': 'no-store' };
const DEFAULT_REPORT_LIMIT = 20;
const MAX_REPORT_LIMIT = 100;

type ParsedQuery =
  | { query: string; normalizedQuery: string }
  | { error: string };

function parseQuery(query: unknown): ParsedQuery {
  if (typeof query !== 'string') return { error: 'query must be a string' };
  const normalized = normalizeCleverSearchQuery(query);
  if (!normalized) return { error: 'query is required' };
  if (Array.from(normalized).length > 120) {
    return { error: 'query must be 120 characters or fewer' };
  }
  return { query: query.trim(), normalizedQuery: normalized };
}

function parseReportLimit(value: string | undefined): number | null {
  if (value === undefined) return DEFAULT_REPORT_LIMIT;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit <= MAX_REPORT_LIMIT ? limit : null;
}

export function makeCleverSearchRouter(deps: CleverSearchRouterDeps): Hono {
  const { db, now, random } = deps;
  ensureCleverSearchSchema(db);
  const router = new Hono();

  const requireSameMachine: MiddlewareHandler = async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!isSameMachineRequest(c)) {
      return c.json({ error: 'same-machine access required' }, 403);
    }
    await next();
  };
  router.use('/api/clever-search', requireSameMachine);
  router.use('/api/clever-search/*', requireSameMachine);

  router.post('/api/clever-search', async (c: Context) => {
    const startedAt = performance.now();
    const body = await c.req.json().catch(() => null) as CleverSearchRequest | null;
    const parsedQuery = parseQuery(body?.query);
    if ('error' in parsedQuery) return c.json({ error: parsedQuery.error }, 400, NO_STORE);
    if (body?.refresh !== undefined && typeof body.refresh !== 'boolean') {
      return c.json({ error: 'refresh must be a boolean' }, 400, NO_STORE);
    }

    const { query, normalizedQuery } = parsedQuery;
    if (!body?.refresh) {
      const cached = findCachedCleverSearchReport(db, normalizedQuery);
      if (cached) {
        const report = parseStoredCleverSearchReport(cached);
        const response: CleverSearchResponse = {
          reportId: cached.id,
          cached: true,
          retrievalElapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
          report,
        };
        return c.json(response, 200, NO_STORE);
      }
    }

    const searchStartedAt = performance.now();
    const hits = searchCleverDocuments(db, normalizedQuery);
    const report = buildCleverSearchReport(query, normalizedQuery, hits, {
      now,
      random,
      searchElapsedMs: performance.now() - searchStartedAt,
    });
    const reportId = saveCleverSearchReport(db, report);
    const response: CleverSearchResponse = {
      reportId,
      cached: false,
      retrievalElapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      report,
    };
    return c.json(response, 200, NO_STORE);
  });

  router.get('/api/clever-search/reports', (c: Context) => {
    const limit = parseReportLimit(c.req.query('limit'));
    if (limit === null) {
      return c.json({ error: 'limit must be an integer from 1 to 100' }, 400, NO_STORE);
    }
    const response: CleverSearchHistoryResponse = {
      items: listCleverSearchReports(db, limit).map((row) => ({
        id: row.id,
        query: row.query,
        totalHits: row.total_hits,
        searchElapsedMs: row.search_elapsed_ms,
        createdAt: row.created_at,
      })),
    };
    return c.json(response, 200, NO_STORE);
  });

  router.get('/api/clever-search/reports/:id', (c: Context) => {
    const startedAt = performance.now();
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id < 1) return c.json({ error: 'invalid report id' }, 400, NO_STORE);
    const stored = getCleverSearchReport(db, id);
    if (!stored) return c.json({ error: 'report not found' }, 404, NO_STORE);
    const report = parseStoredCleverSearchReport(stored);
    const response: CleverSearchResponse = {
      reportId: stored.id,
      cached: true,
      retrievalElapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      report,
    };
    return c.json(response, 200, NO_STORE);
  });

  return router;
}
