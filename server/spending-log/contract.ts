import { z } from 'zod';
import { DIARY_ONLY_SCOPE, LLM_RELAY_SCOPES } from './relay-policy.js';

export const SPENDING_LOG_PRIVACY_CLASS = 'sensitive.financial_location' as const;

// llm_relay_scope は relay-policy.ts が正本。 保存行は本人同意による昇格後の値も持つため
// 両方を受ける。 Quaestor入力は下の専用スキーマで diary_only に制限する。
const LlmRelayScopeSchema = z.enum(LLM_RELAY_SCOPES);

const IsoDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'invalid calendar date');
const IsoDateTimeSchema = z.string().datetime();
const HttpUrlSchema = z.string().url().refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}, 'URL must use http or https');
const PurchaseCategorySchema = z.enum(['food', 'clothing', 'toy', 'undetermined']);
const PaymentKindSchema = z.enum([
  'credit_card',
  'bank',
  'cash',
  'digital_wallet',
  'other',
  'undetermined',
]);

export const SpendingLogRecordSchema = z.object({
  id: z.string().min(1),
  privacy_class: z.literal(SPENDING_LOG_PRIVACY_CLASS),
  retention_scope: z.literal('local_only'),
  llm_relay_scope: LlmRelayScopeSchema,
  source_kind: z.enum(['transaction', 'receipt']),
  date: IsoDateSchema,
  occurred_at: IsoDateTimeSchema.nullable(),
  amount: z.number().int().positive(),
  currency: z.string().min(3).max(8),
  place: z.object({
    name: z.string().nullable(),
    google_place_id: z.string().nullable(),
    google_maps_url: HttpUrlSchema.nullable(),
    location: z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracy_m: z.number().nonnegative().nullable(),
    }).nullable(),
  }),
  payment: z.object({
    kind: PaymentKindSchema,
    label: z.string().nullable(),
  }),
  items: z.array(z.object({
    name: z.string().min(1),
    price: z.number().int(),
    quantity: z.number().positive().nullable(),
    category: PurchaseCategorySchema,
  })),
  purchase_category: PurchaseCategorySchema,
  expense: z.object({
    planned: z.boolean().nullable(),
    rate: z.number().min(0).max(1).nullable(),
    rule_id: z.number().int().positive().nullable(),
  }),
  source_refs: z.object({
    transaction_id: z.string().nullable(),
    receipt_ids: z.array(z.string()),
  }),
  source_updated_at: IsoDateTimeSchema,
});

// Quaestor は権限を昇格できない。 広い relay scope は Memoria 内で本人同意を
// 適用した保存行だけが持てる値にする。
const QuaestorSpendingLogRecordSchema = SpendingLogRecordSchema.extend({
  llm_relay_scope: z.literal(DIARY_ONLY_SCOPE),
});

export const QuaestorSpendingLogExportSchema = z.object({
  schema_version: z.literal(1),
  privacy_class: z.literal(SPENDING_LOG_PRIVACY_CLASS),
  retention_scope: z.literal('local_only'),
  llm_relay_scope: z.literal(DIARY_ONLY_SCOPE),
  date_from: IsoDateSchema,
  date_to: IsoDateSchema,
  records: z.array(QuaestorSpendingLogRecordSchema),
  daily_summaries: z.array(z.object({
    date: IsoDateSchema,
    currency: z.string().min(3).max(8),
    total_amount: z.number().int().nonnegative(),
    places: z.array(z.object({
      name: z.string().nullable(),
      google_maps_url: HttpUrlSchema.nullable(),
      amount: z.number().int().nonnegative(),
    })),
  })),
});

export type SpendingLogRecord = z.infer<typeof SpendingLogRecordSchema>;
export type QuaestorSpendingLogExport = z.infer<typeof QuaestorSpendingLogExportSchema>;

export interface DailySpendingSummary {
  date: string;
  currency: string;
  total_amount: number;
  places: Array<{
    name: string | null;
    google_maps_url: string | null;
    amount: number;
  }>;
}
