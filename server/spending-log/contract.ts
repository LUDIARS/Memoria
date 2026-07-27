import { z } from 'zod';

export const SPENDING_LOG_PRIVACY_CLASS = 'sensitive.financial_location' as const;

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IsoDateTimeSchema = z.string().datetime();
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
  llm_relay_scope: z.literal('diary_only'),
  source_kind: z.enum(['transaction', 'receipt']),
  date: IsoDateSchema,
  occurred_at: IsoDateTimeSchema.nullable(),
  amount: z.number().int().positive(),
  currency: z.string().min(3).max(8),
  place: z.object({
    name: z.string().nullable(),
    google_place_id: z.string().nullable(),
    google_maps_url: z.string().url().nullable(),
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

export const QuaestorSpendingLogExportSchema = z.object({
  schema_version: z.literal(1),
  privacy_class: z.literal(SPENDING_LOG_PRIVACY_CLASS),
  retention_scope: z.literal('local_only'),
  llm_relay_scope: z.literal('diary_only'),
  date_from: IsoDateSchema,
  date_to: IsoDateSchema,
  records: z.array(SpendingLogRecordSchema),
  daily_summaries: z.array(z.object({
    date: IsoDateSchema,
    currency: z.string().min(3).max(8),
    total_amount: z.number().int().nonnegative(),
    places: z.array(z.object({
      name: z.string().nullable(),
      google_maps_url: z.string().url().nullable(),
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
