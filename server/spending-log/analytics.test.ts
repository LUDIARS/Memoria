import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSpending, listCurrencies } from './analytics.js';
import type { SpendingLogRecord } from './contract.js';

function record(overrides: Partial<SpendingLogRecord> & { id: string; date: string; amount: number }): SpendingLogRecord {
  return {
    privacy_class: 'sensitive.financial_location',
    retention_scope: 'local_only',
    llm_relay_scope: 'diary_only',
    source_kind: 'transaction',
    occurred_at: `${overrides.date}T04:00:00.000Z`,
    currency: 'JPY',
    place: { name: 'テスト店', google_place_id: null, google_maps_url: null, location: null },
    payment: { kind: 'credit_card', label: 'カードA' },
    items: [],
    purchase_category: 'food',
    expense: { planned: null, rate: null, rule_id: null },
    source_refs: { transaction_id: null, receipt_ids: [] },
    source_updated_at: `${overrides.date}T04:01:00.000Z`,
    ...overrides,
  } as SpendingLogRecord;
}

const RANGE = { dateFrom: '2026-06-01', dateTo: '2026-07-31' };

test('合計・日平均・通貨フィルタ', () => {
  const records = [
    record({ id: 'a', date: '2026-07-01', amount: 1_000 }),
    record({ id: 'b', date: '2026-07-02', amount: 2_000 }),
    record({ id: 'c', date: '2026-07-03', amount: 500, currency: 'USD' }),
  ];
  const analytics = analyzeSpending(records, 'JPY', RANGE);
  assert.equal(analytics.record_count, 2);
  assert.equal(analytics.total_amount, 3_000);
  // 2026-06-01 〜 2026-07-31 = 61 日
  assert.equal(analytics.daily_average, Math.round(3_000 / 61));
  assert.deepEqual(listCurrencies(records), ['JPY', 'USD']);
});

test('既定候補では件数の多い通貨を先頭にする', () => {
  const records = [
    record({ id: 'a', date: '2026-07-01', amount: 10, currency: 'USD' }),
    record({ id: 'b', date: '2026-07-02', amount: 20, currency: 'EUR' }),
    record({ id: 'c', date: '2026-07-03', amount: 30, currency: 'EUR' }),
  ];
  assert.deepEqual(listCurrencies(records), ['EUR', 'USD']);
});

test('前月比は直近 2 ヶ月の差分', () => {
  const analytics = analyzeSpending([
    record({ id: 'a', date: '2026-06-10', amount: 1_000 }),
    record({ id: 'b', date: '2026-07-10', amount: 1_500 }),
  ], 'JPY', RANGE);
  assert.equal(analytics.month_over_month?.delta_amount, 500);
  assert.equal(analytics.month_over_month?.delta_ratio, 0.5);
});

test('月が連続していなければ前月比を出さない', () => {
  const analytics = analyzeSpending([
    record({ id: 'a', date: '2026-05-10', amount: 1_000 }),
    record({ id: 'b', date: '2026-07-10', amount: 1_500 }),
  ], 'JPY', { dateFrom: '2026-05-01', dateTo: '2026-07-31' });
  assert.equal(analytics.month_over_month, null);
});

test('同一店舗・同一金額が 2 ヶ月出れば定期課金候補', () => {
  const analytics = analyzeSpending([
    record({ id: 'a', date: '2026-06-05', amount: 980 }),
    record({ id: 'b', date: '2026-07-05', amount: 980 }),
    record({ id: 'c', date: '2026-07-06', amount: 300 }),
  ], 'JPY', RANGE);
  assert.equal(analytics.recurring_charges.length, 1);
  assert.deepEqual(analytics.recurring_charges[0].months, ['2026-06', '2026-07']);
});

test('店名不明の支出は定期課金候補にまとめない', () => {
  const noPlace = { name: null, google_place_id: null, google_maps_url: null, location: null };
  const analytics = analyzeSpending([
    record({ id: 'a', date: '2026-06-05', amount: 980, place: noPlace }),
    record({ id: 'b', date: '2026-07-05', amount: 980, place: noPlace }),
  ], 'JPY', RANGE);
  assert.equal(analytics.recurring_charges.length, 0);
});

test('分類中央値の 3 倍以上は突出支出', () => {
  const analytics = analyzeSpending([
    record({ id: 'a', date: '2026-07-01', amount: 1_000 }),
    record({ id: 'b', date: '2026-07-02', amount: 1_000 }),
    record({ id: 'c', date: '2026-07-03', amount: 1_200 }),
    record({ id: 'd', date: '2026-07-04', amount: 9_000 }),
  ], 'JPY', RANGE);
  assert.deepEqual(analytics.outliers.map((outlier) => outlier.id), ['d']);
});

test('件数が 3 件未満の分類では突出支出を出さない', () => {
  const analytics = analyzeSpending([
    record({ id: 'a', date: '2026-07-01', amount: 100 }),
    record({ id: 'b', date: '2026-07-02', amount: 100_000 }),
  ], 'JPY', RANGE);
  assert.equal(analytics.outliers.length, 0);
});

test('label が別 kind の生 key と衝突しても支払手段を混ぜない', () => {
  const analytics = analyzeSpending([
    // label が別 kind の生 key と同じ文字列になるケース。
    record({ id: 'a', date: '2026-07-01', amount: 100, payment: { kind: 'credit_card', label: 'cash' } }),
    record({ id: 'b', date: '2026-07-02', amount: 200, payment: { kind: 'cash', label: null } }),
  ], 'JPY', RANGE);
  assert.equal(analytics.by_payment.length, 2);
  assert.deepEqual(
    analytics.by_payment.map((bucket) => bucket.amount).sort((x, y) => x - y),
    [100, 200],
  );
});

test('予定 / 想定外の内訳', () => {
  const analytics = analyzeSpending([
    record({ id: 'a', date: '2026-07-01', amount: 100, expense: { planned: true, rate: null, rule_id: null } }),
    record({ id: 'b', date: '2026-07-02', amount: 200, expense: { planned: false, rate: null, rule_id: null } }),
    record({ id: 'c', date: '2026-07-03', amount: 300 }),
  ], 'JPY', RANGE);
  assert.deepEqual(analytics.planned_vs_unplanned, { planned: 100, unplanned: 200, undetermined: 300 });
});
