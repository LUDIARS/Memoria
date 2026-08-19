import { Hono } from 'hono';
import { z } from 'zod';
import { listCurrencies } from './analytics.js';
import {
  generateSpendingAdvice,
  listSpendingAdviceReports,
  SpendingAdviceConsentError,
} from './advice.js';
import { readSpendingAdviceSettings, writeSpendingAdviceSettings } from './settings.js';
import { applyRelayConsent, listSpendingLogs } from './store.js';
import {
  CurrencySchema,
  DateSchema,
  DEFAULT_CURRENCY,
  readJsonBody,
  resolveRange,
  type SpendingLogRouterDeps,
} from './router-deps.js';

/**
 * 消費傾向の助言 (ローカル LLM) と、 その前提になる本人同意設定を担当する。
 * 同意が無い状態では 403 を返し、 助言を生成しない。
 */

const AdviceSettingsSchema = z.object({
  consent: z.boolean().optional(),
  base_url: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
const AdviceRequestSchema = z.object({
  date_from: DateSchema.optional(),
  date_to: DateSchema.optional(),
  currency: CurrencySchema.optional(),
});

export function makeSpendingAdviceRouter(deps: SpendingLogRouterDeps): Hono {
  const router = new Hono();

  router.get('/api/spending-logs/advice/settings', (c) => {
    return c.json({ settings: readSpendingAdviceSettings(deps.db) });
  });

  // 同意の切り替えは保存済みの行の relay scope にも即時反映する。 同意を取り消したら
  // 昇格済みの行を diary_only へ戻し、 以後の助言生成から外す。
  router.put('/api/spending-logs/advice/settings', async (c) => {
    const body = await readJsonBody(c.req.text());
    if ('error' in body) return c.json({ error: body.error }, 400);
    const parsed = AdviceSettingsSchema.safeParse(body.value);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const settings = writeSpendingAdviceSettings(deps.db, parsed.data);
    const relayScopeUpdated = parsed.data.consent === undefined
      ? 0
      : applyRelayConsent(deps.db, settings.consent);
    return c.json({ ok: true, settings, relay_scope_updated: relayScopeUpdated });
  });

  router.get('/api/spending-logs/advice', (c) => {
    return c.json({
      settings: readSpendingAdviceSettings(deps.db),
      reports: listSpendingAdviceReports(deps.db),
    });
  });

  router.post('/api/spending-logs/advice', async (c) => {
    const body = await readJsonBody(c.req.text());
    if ('error' in body) return c.json({ error: body.error }, 400);
    const parsed = AdviceRequestSchema.safeParse(body.value);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const range = resolveRange(deps, parsed.data.date_from, parsed.data.date_to);
    if ('error' in range) return c.json({ error: range.error }, 400);

    const currency = parsed.data.currency ?? dominantCurrency(deps, range);
    try {
      const report = await generateSpendingAdvice({
        db: deps.db,
        range,
        currency,
        fetchImpl: deps.fetchImpl,
        now: deps.now,
      });
      return c.json({ ok: true, report });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SpendingAdviceConsentError) return c.json({ error: message }, 403);
      return c.json({ error: message }, 502);
    }
  });

  return router;
}

function dominantCurrency(
  deps: SpendingLogRouterDeps,
  range: { dateFrom: string; dateTo: string },
): string {
  const records = listSpendingLogs(deps.db, { dateFrom: range.dateFrom, dateTo: range.dateTo });
  return listCurrencies(records)[0] ?? DEFAULT_CURRENCY;
}
