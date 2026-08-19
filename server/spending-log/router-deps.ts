import { z } from 'zod';
import type BetterSqlite3 from 'better-sqlite3';

/**
 * spending log の各サブルータが共有する依存と、 期間指定の解釈だけを持つ。
 * ルーティングやドメイン処理は持たない。
 */

export interface SpendingLogRouterDeps {
  db: BetterSqlite3.Database;
  quaestorBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export const DateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isValidIsoDate, 'invalid calendar date');
export const CurrencySchema = z.string().min(3).max(8);

/** 対象期間に 1 件も支出が無いときでも形のある応答を返すための既定通貨。 */
export const DEFAULT_CURRENCY = 'JPY';

/** 既定の集計期間 (直近 30 日)。 */
const DEFAULT_RANGE_DAYS = 30;
/** 1 回のリクエストで扱える最大期間。 */
const MAX_RANGE_DAYS = 366;

export interface DateRange {
  dateFrom: string;
  dateTo: string;
}

export type RangeResult = DateRange | { error: string };

export function resolveRange(
  deps: SpendingLogRouterDeps,
  dateFrom: string | undefined,
  dateTo: string | undefined,
): RangeResult {
  const fallback = defaultRange(deps.now?.() ?? new Date());
  const from = dateFrom ?? fallback.dateFrom;
  const to = dateTo ?? fallback.dateTo;
  const rangeError = validateRange(from, to);
  if (rangeError) return { error: rangeError };
  return { dateFrom: from, dateTo: to };
}

function defaultRange(now: Date): DateRange {
  const end = new Date(now);
  const start = new Date(now);
  start.setDate(start.getDate() - (DEFAULT_RANGE_DAYS - 1));
  return { dateFrom: localDate(start), dateTo: localDate(end) };
}

function validateRange(dateFrom: string, dateTo: string): string | null {
  if (dateFrom > dateTo) return 'date_from must be on or before date_to';
  const start = Date.parse(`${dateFrom}T00:00:00Z`);
  const end = Date.parse(`${dateTo}T00:00:00Z`);
  if ((end - start) / 86_400_000 > MAX_RANGE_DAYS) {
    return `date range must not exceed ${MAX_RANGE_DAYS} days`;
  }
  return null;
}

export async function readJsonBody(
  rawPromise: Promise<string> | string,
): Promise<{ value: unknown } | { error: string }> {
  try {
    const raw = await rawPromise;
    return { value: raw ? JSON.parse(raw) : {} };
  } catch {
    return { error: 'invalid JSON body' };
  }
}

function localDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isValidIsoDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
