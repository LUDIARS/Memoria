import { Hono } from 'hono';
import { z } from 'zod';
import { analyzeSpending, listCurrencies } from './analytics.js';
import { SPENDING_LOG_PRIVACY_CLASS } from './contract.js';
import { buildStayEvidence, groupStaysByDate } from './stay-match.js';
import { listSpendingLogs } from './store.js';
import {
  CurrencySchema,
  DateSchema,
  DEFAULT_CURRENCY,
  resolveRange,
  type SpendingLogRouterDeps,
} from './router-deps.js';

/**
 * LLM を通さない読み取り系。 滞在記録の補強 (GPS 突合) と傾向集計を返す。
 * どちらも決定的なので、 助言の同意状態に関係なく利用できる。
 */

const RangeQuerySchema = z.object({
  date_from: DateSchema.optional(),
  date_to: DateSchema.optional(),
  currency: CurrencySchema.optional(),
});

export function makeSpendingInsightRouter(deps: SpendingLogRouterDeps): Hono {
  const router = new Hono();

  // 突合結果は保存しない。 GPS 側を書き換えないので retention の増加も起きない。
  router.get('/api/spending-logs/stays', (c) => {
    const parsed = RangeQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const range = resolveRange(deps, parsed.data.date_from, parsed.data.date_to);
    if ('error' in range) return c.json({ error: range.error }, 400);

    const records = listSpendingLogs(deps.db, { dateFrom: range.dateFrom, dateTo: range.dateTo });
    const evidence = buildStayEvidence(deps.db, records);
    return c.json({
      privacy_class: SPENDING_LOG_PRIVACY_CLASS,
      retention_scope: 'local_only',
      date_from: range.dateFrom,
      date_to: range.dateTo,
      days: groupStaysByDate(evidence),
      count: evidence.length,
    });
  });

  router.get('/api/spending-logs/analytics', (c) => {
    const parsed = RangeQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const range = resolveRange(deps, parsed.data.date_from, parsed.data.date_to);
    if ('error' in range) return c.json({ error: range.error }, 400);

    const records = listSpendingLogs(deps.db, { dateFrom: range.dateFrom, dateTo: range.dateTo });
    const currencies = listCurrencies(records);
    const currency = parsed.data.currency ?? currencies[0] ?? DEFAULT_CURRENCY;
    return c.json({
      privacy_class: SPENDING_LOG_PRIVACY_CLASS,
      retention_scope: 'local_only',
      currencies,
      analytics: analyzeSpending(records, currency, {
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
      }),
    });
  });

  return router;
}
