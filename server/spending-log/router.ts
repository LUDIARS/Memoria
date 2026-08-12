import { Hono } from 'hono';
import { z } from 'zod';
import type BetterSqlite3 from 'better-sqlite3';
import { isSameMachineRequest } from '../lib/local-request.js';
import { ensureSpendingLogSchema } from './schema.js';
import { fetchQuaestorSpendingLogs } from './quaestor-client.js';
import {
  listSpendingLogs,
  replaceQuaestorRange,
  summarizeSpendingLogs,
} from './store.js';

type Db = BetterSqlite3.Database;

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ListQuerySchema = z.object({
  date_from: DateSchema.optional(),
  date_to: DateSchema.optional(),
});
const SyncBodySchema = z.object({
  date_from: DateSchema.optional(),
  date_to: DateSchema.optional(),
});

export interface SpendingLogRouterDeps {
  db: Db;
  quaestorBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function makeSpendingLogRouter(deps: SpendingLogRouterDeps): Hono {
  ensureSpendingLogSchema(deps.db);
  const router = new Hono();

  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    // Accept requests forwarded by the configured Access host while retaining
    // the local peer and same-origin checks for direct access and CSRF.
    if (!isSameMachineRequest(c)) {
      return c.json({ error: 'same-machine access required' }, 403);
    }
    await next();
  });

  router.get('/api/spending-logs', (c) => {
    const parsed = ListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (parsed.data.date_from && parsed.data.date_to && parsed.data.date_from > parsed.data.date_to) {
      return c.json({ error: 'date_from must be on or before date_to' }, 400);
    }
    const records = listSpendingLogs(deps.db, {
      dateFrom: parsed.data.date_from,
      dateTo: parsed.data.date_to,
    });
    return c.json({
      privacy_class: 'sensitive.financial_location',
      retention_scope: 'local_only',
      llm_relay_scope: 'diary_only',
      records,
      count: records.length,
      daily_summaries: summarizeSpendingLogs(records),
    });
  });

  router.post('/api/spending-logs/sync', async (c) => {
    let body: unknown = {};
    try {
      const raw = await c.req.text();
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = SyncBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const fallback = defaultRange(deps.now?.() ?? new Date());
    const dateFrom = parsed.data.date_from ?? fallback.dateFrom;
    const dateTo = parsed.data.date_to ?? fallback.dateTo;
    const rangeError = validateRange(dateFrom, dateTo);
    if (rangeError) return c.json({ error: rangeError }, 400);

    const baseUrl = deps.quaestorBaseUrl ?? process.env.QUAESTOR_URL;
    if (!baseUrl) {
      return c.json({ error: 'QUAESTOR_URL is not configured by Excubitor' }, 503);
    }
    try {
      const exported = await fetchQuaestorSpendingLogs(
        baseUrl,
        { dateFrom, dateTo },
        deps.fetchImpl,
      );
      if (exported.date_from !== dateFrom || exported.date_to !== dateTo) {
        return c.json({ error: 'Quaestor returned a different date range' }, 502);
      }
      const result = replaceQuaestorRange(deps.db, exported);
      const records = listSpendingLogs(deps.db, { dateFrom, dateTo });
      return c.json({
        ok: true,
        privacy_class: exported.privacy_class,
        retention_scope: exported.retention_scope,
        llm_relay_scope: exported.llm_relay_scope,
        date_from: dateFrom,
        date_to: dateTo,
        ...result,
        daily_summaries: summarizeSpendingLogs(records),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 502);
    }
  });

  return router;
}

function defaultRange(now: Date): { dateFrom: string; dateTo: string } {
  const end = new Date(now);
  const start = new Date(now);
  start.setDate(start.getDate() - 29);
  return {
    dateFrom: localDate(start),
    dateTo: localDate(end),
  };
}

function localDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function validateRange(dateFrom: string, dateTo: string): string | null {
  if (dateFrom > dateTo) return 'date_from must be on or before date_to';
  const start = Date.parse(`${dateFrom}T00:00:00Z`);
  const end = Date.parse(`${dateTo}T00:00:00Z`);
  if ((end - start) / 86_400_000 > 366) return 'date range must not exceed 366 days';
  return null;
}
