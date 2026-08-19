import type { SpendingLogRecord } from './contract.js';

/**
 * spending log から消費傾向の「事実」を決定的に集計する。 助言文の生成 (advice.ts) とは
 * 分離し、 ここは LLM を一切呼ばない。 同じ入力なら常に同じ出力になる。
 */

/** 定期課金候補と見なす最小出現月数。 2 ヶ月に同額同店なら候補にする。 */
const RECURRING_MIN_MONTHS = 2;
/** 突出支出と見なす閾値。 その分類の中央値の何倍か。 */
const OUTLIER_MEDIAN_MULTIPLIER = 3;
/** 上位いくつまで返すか (店・突出支出)。 */
const TOP_N = 10;

export interface AmountBucket {
  key: string;
  label: string;
  amount: number;
  count: number;
  share: number;
}

export interface MonthlyTotal {
  month: string;
  amount: number;
  count: number;
}

export interface RecurringCharge {
  place_name: string | null;
  amount: number;
  months: string[];
  payment_label: string | null;
}

export interface OutlierSpend {
  id: string;
  date: string;
  place_name: string | null;
  amount: number;
  purchase_category: SpendingLogRecord['purchase_category'];
  median_of_category: number;
}

export interface MonthOverMonth {
  latest: MonthlyTotal;
  previous: MonthlyTotal;
  delta_amount: number;
  delta_ratio: number;
}

export interface SpendingAnalytics {
  currency: string;
  date_from: string;
  date_to: string;
  record_count: number;
  total_amount: number;
  daily_average: number;
  by_source_kind: AmountBucket[];
  by_purchase_category: AmountBucket[];
  by_payment: AmountBucket[];
  by_place: AmountBucket[];
  by_weekday: AmountBucket[];
  monthly_totals: MonthlyTotal[];
  month_over_month: MonthOverMonth | null;
  recurring_charges: RecurringCharge[];
  outliers: OutlierSpend[];
  planned_vs_unplanned: { planned: number; unplanned: number; undetermined: number };
}

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

const SOURCE_KIND_LABELS: Record<SpendingLogRecord['source_kind'], string> = {
  receipt: 'レシート',
  transaction: 'クレカ / 取引明細',
};

const CATEGORY_LABELS: Record<SpendingLogRecord['purchase_category'], string> = {
  food: '食費',
  clothing: '衣類',
  toy: '趣味 / 玩具',
  undetermined: '未分類',
};

const PAYMENT_KIND_LABELS: Record<string, string> = {
  credit_card: 'クレジットカード',
  bank: '銀行',
  cash: '現金',
  digital_wallet: '電子マネー / Pay',
  other: 'その他',
  undetermined: '不明',
};

export interface AnalyzeRange {
  dateFrom: string;
  dateTo: string;
}

export function analyzeSpending(
  records: SpendingLogRecord[],
  currency: string,
  range: AnalyzeRange,
): SpendingAnalytics {
  const target = records.filter((record) => record.currency === currency);
  const total = sum(target.map((record) => record.amount));
  const days = Math.max(1, countDays(range.dateFrom, range.dateTo));
  const monthly = monthlyTotals(target);

  return {
    currency,
    date_from: range.dateFrom,
    date_to: range.dateTo,
    record_count: target.length,
    total_amount: total,
    daily_average: Math.round(total / days),
    by_source_kind: bucketize(
      target,
      total,
      (record) => record.source_kind,
      (key) => SOURCE_KIND_LABELS[key as SpendingLogRecord['source_kind']] ?? key,
    ),
    by_purchase_category: bucketize(
      target,
      total,
      (record) => record.purchase_category,
      (key) => CATEGORY_LABELS[key as SpendingLogRecord['purchase_category']] ?? key,
    ),
    by_payment: bucketize(
      target,
      total,
      (record) => record.payment.label ?? record.payment.kind,
      (key, record) => record.payment.label ?? PAYMENT_KIND_LABELS[key] ?? key,
    ),
    by_place: bucketize(
      target,
      total,
      (record) => record.place.name ?? PLACE_UNKNOWN,
      (key) => key,
    ).slice(0, TOP_N),
    by_weekday: bucketize(
      target,
      total,
      (record) => String(weekdayIndex(record.date)),
      (key) => WEEKDAY_LABELS[Number(key)] ?? key,
    ),
    monthly_totals: monthly,
    month_over_month: monthOverMonth(monthly),
    recurring_charges: detectRecurringCharges(target),
    outliers: detectOutliers(target),
    planned_vs_unplanned: plannedBreakdown(target),
  };
}

const PLACE_UNKNOWN = '(場所不明)';

function bucketize(
  records: SpendingLogRecord[],
  total: number,
  keyOf: (record: SpendingLogRecord) => string,
  labelOf: (key: string, record: SpendingLogRecord) => string,
): AmountBucket[] {
  const buckets = new Map<string, AmountBucket>();
  for (const record of records) {
    const key = keyOf(record);
    const bucket = buckets.get(key)
      ?? { key, label: labelOf(key, record), amount: 0, count: 0, share: 0 };
    bucket.amount += record.amount;
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map((bucket) => ({ ...bucket, share: total > 0 ? round2(bucket.amount / total) : 0 }))
    .sort((a, b) => b.amount - a.amount);
}

function monthlyTotals(records: SpendingLogRecord[]): MonthlyTotal[] {
  const months = new Map<string, MonthlyTotal>();
  for (const record of records) {
    const month = record.date.slice(0, 7);
    const entry = months.get(month) ?? { month, amount: 0, count: 0 };
    entry.amount += record.amount;
    entry.count += 1;
    months.set(month, entry);
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
}

function monthOverMonth(monthly: MonthlyTotal[]): MonthOverMonth | null {
  if (monthly.length < 2) return null;
  const latest = monthly[monthly.length - 1];
  const previousMonth = shiftMonth(latest.month, -1);
  const previous = monthly.find((entry) => entry.month === previousMonth);
  if (!previous) return null;
  const delta = latest.amount - previous.amount;
  return {
    latest,
    previous,
    delta_amount: delta,
    delta_ratio: previous.amount > 0 ? round2(delta / previous.amount) : 0,
  };
}

function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return shifted.toISOString().slice(0, 7);
}

/**
 * 同じ店・同じ金額が複数の月に現れるものを定期課金候補として拾う。 サブスクの棚卸しは
 * 節制助言でいちばん効くので、 推測ではなく一致だけで機械的に出す。
 */
function detectRecurringCharges(records: SpendingLogRecord[]): RecurringCharge[] {
  const groups = new Map<string, RecurringCharge>();
  for (const record of records) {
    if (!record.place.name) continue;
    const key = `${record.place.name ?? ''}\u0000${record.amount}`;
    const group = groups.get(key) ?? {
      place_name: record.place.name,
      amount: record.amount,
      months: [] as string[],
      payment_label: record.payment.label,
    };
    const month = record.date.slice(0, 7);
    if (!group.months.includes(month)) group.months.push(month);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.months.length >= RECURRING_MIN_MONTHS)
    .map((group) => ({ ...group, months: [...group.months].sort() }))
    .sort((a, b) => b.months.length * b.amount - a.months.length * a.amount);
}

/** 分類ごとの中央値から大きく外れた支出を突出支出として出す。 */
function detectOutliers(records: SpendingLogRecord[]): OutlierSpend[] {
  const byCategory = new Map<string, SpendingLogRecord[]>();
  for (const record of records) {
    const list = byCategory.get(record.purchase_category) ?? [];
    list.push(record);
    byCategory.set(record.purchase_category, list);
  }
  const outliers: OutlierSpend[] = [];
  for (const [category, list] of byCategory) {
    if (list.length < 3) continue;
    const median = medianOf(list.map((record) => record.amount));
    if (median <= 0) continue;
    for (const record of list) {
      if (record.amount < median * OUTLIER_MEDIAN_MULTIPLIER) continue;
      outliers.push({
        id: record.id,
        date: record.date,
        place_name: record.place.name,
        amount: record.amount,
        purchase_category: category as SpendingLogRecord['purchase_category'],
        median_of_category: median,
      });
    }
  }
  return outliers.sort((a, b) => b.amount - a.amount).slice(0, TOP_N);
}

function plannedBreakdown(records: SpendingLogRecord[]): SpendingAnalytics['planned_vs_unplanned'] {
  const result = { planned: 0, unplanned: 0, undetermined: 0 };
  for (const record of records) {
    if (record.expense.planned === true) result.planned += record.amount;
    else if (record.expense.planned === false) result.unplanned += record.amount;
    else result.undetermined += record.amount;
  }
  return result;
}

export function listCurrencies(records: SpendingLogRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    counts.set(record.currency, (counts.get(record.currency) ?? 0) + 1);
  }
  // 金額は通貨間で比較できないため、 レコード件数が多い通貨を既定候補の先頭にする。
  // 同数なら通貨コードで決定的に並べる。
  return [...counts]
    .sort(([currencyA, countA], [currencyB, countB]) => (
      countB - countA || currencyA.localeCompare(currencyB)
    ))
    .map(([currency]) => currency);
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function countDays(dateFrom: string, dateTo: string): number {
  const start = Date.parse(`${dateFrom}T00:00:00Z`);
  const end = Date.parse(`${dateTo}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 1;
  return Math.floor((end - start) / 86_400_000) + 1;
}

function weekdayIndex(date: string): number {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(parsed) ? 0 : new Date(parsed).getUTCDay();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
