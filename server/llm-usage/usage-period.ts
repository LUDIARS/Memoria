import { jstDate } from './jsonl.js';

/** Inclusive JST calendar range: `from` 00:00 JST up to (not including) the day after `to`. */
export interface UsagePeriod { from: string; to: string }

export const DEFAULT_PERIOD_DAYS = 7;
const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class InvalidPeriodError extends Error {}

/**
 * Parse `from` / `to` query values. Missing values default to the last
 * DEFAULT_PERIOD_DAYS JST days including today; malformed values are rejected
 * rather than silently replaced by the default.
 */
export function parseUsagePeriod(
  from: string | undefined,
  to: string | undefined,
  nowMs = Date.now(),
): UsagePeriod {
  const end = to === undefined ? jstDate(nowMs) : validDate(to, 'to');
  const start = from === undefined ? shiftDate(end, -(DEFAULT_PERIOD_DAYS - 1)) : validDate(from, 'from');
  if (start > end) throw new InvalidPeriodError('from must not be after to');
  return { from: start, to: end };
}

export function shiftDate(date: string, days: number): string {
  return jstDate(Date.parse(`${date}T00:00:00+09:00`) + days * DAY_MS);
}

function validDate(value: string, name: string): string {
  // Round-trip through the calendar so 2026-02-30 is rejected, not rolled over.
  if (!DATE_PATTERN.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00+09:00`))
    || shiftDate(value, 0) !== value) {
    throw new InvalidPeriodError(`${name} must be a YYYY-MM-DD date`);
  }
  return value;
}
