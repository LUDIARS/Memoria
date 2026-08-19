import { Hono } from 'hono';
import { z } from 'zod';
import { SPENDING_LOG_PRIVACY_CLASS } from './contract.js';
import { fetchQuaestorSpendingLogs } from './quaestor-client.js';
import { DIARY_ONLY_SCOPE, SPENDING_ADVICE_SCOPE } from './relay-policy.js';
import { readSpendingAdviceSettings } from './settings.js';
import { listSpendingLogs, replaceQuaestorRange, summarizeSpendingLogs } from './store.js';
import {
  DateSchema,
  resolveRange,
  readJsonBody,
  type SpendingLogRouterDeps,
} from './router-deps.js';

/** Quaestor からの取り込みと、 取り込んだ生ログの一覧を担当する。 */

const SourceKindSchema = z.enum(['receipt', 'transaction']);
const ListQuerySchema = z.object({
  date_from: DateSchema.optional(),
  date_to: DateSchema.optional(),
  source_kind: SourceKindSchema.optional(),
});
const SyncBodySchema = z.object({
  date_from: DateSchema.optional(),
  date_to: DateSchema.optional(),
});

export function makeSpendingSyncRouter(deps: SpendingLogRouterDeps): Hono {
  const router = new Hono();

  router.get('/api/spending-logs', (c) => {
    const parsed = ListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (parsed.data.date_from && parsed.data.date_to && parsed.data.date_from > parsed.data.date_to) {
      return c.json({ error: 'date_from must be on or before date_to' }, 400);
    }
    const records = listSpendingLogs(deps.db, {
      dateFrom: parsed.data.date_from,
      dateTo: parsed.data.date_to,
      sourceKind: parsed.data.source_kind,
    });
    return c.json({
      privacy_class: SPENDING_LOG_PRIVACY_CLASS,
      retention_scope: 'local_only',
      // 実際に保存されている scope を返す。 本人同意が無ければ diary_only のまま。
      llm_relay_scope: readSpendingAdviceSettings(deps.db).consent
        ? SPENDING_ADVICE_SCOPE
        : DIARY_ONLY_SCOPE,
      records,
      count: records.length,
      daily_summaries: summarizeSpendingLogs(records),
    });
  });

  router.post('/api/spending-logs/sync', async (c) => {
    const body = await readJsonBody(c.req.text());
    if ('error' in body) return c.json({ error: body.error }, 400);
    const parsed = SyncBodySchema.safeParse(body.value);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const range = resolveRange(deps, parsed.data.date_from, parsed.data.date_to);
    if ('error' in range) return c.json({ error: range.error }, 400);
    const { dateFrom, dateTo } = range;

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
      // 保存時の実効 relay scope は本人同意で決まる (relay-policy.ts)。
      const consent = readSpendingAdviceSettings(deps.db).consent;
      const syncedAt = (deps.now?.() ?? new Date()).toISOString();
      const result = replaceQuaestorRange(deps.db, exported, syncedAt, consent);
      const records = listSpendingLogs(deps.db, { dateFrom, dateTo });
      return c.json({
        ok: true,
        privacy_class: exported.privacy_class,
        retention_scope: exported.retention_scope,
        llm_relay_scope: consent ? SPENDING_ADVICE_SCOPE : DIARY_ONLY_SCOPE,
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
