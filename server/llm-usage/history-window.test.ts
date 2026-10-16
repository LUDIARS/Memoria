import assert from 'node:assert/strict';
import test from 'node:test';
import { historyTicks, jstInputValue, parseJstInput, shiftedHistoryStart } from '../public/src/llm-history-window.js';

test('time labels span the full window with equal time and position intervals for every range', () => {
  for (const span of [90 * 86400, 30 * 86400, 7 * 86400, 86400, 3600]) {
    const from = 1700000000;
    const ticks = historyTicks(from, from + span);
    assert.equal(ticks[0].ts, from);
    assert.equal(ticks[ticks.length - 1].ts, from + span);
    for (let i = 1; i < ticks.length; i++) {
      assert.ok(Math.abs((ticks[i].ts - ticks[i - 1].ts) - span / (ticks.length - 1)) < 0.000001);
      assert.ok(Math.abs((ticks[i].ratio - ticks[i - 1].ratio) - 1 / (ticks.length - 1)) < 0.000001);
    }
  }
});

test('JST input and tick labels remain Japan time across midnight regardless of browser timezone', () => {
  const ts = Date.parse('2026-10-15T15:00:00Z') / 1000;
  assert.equal(jstInputValue(ts), '2026-10-16T00:00');
  assert.equal(parseJstInput('2026-10-16T00:00'), ts);
  const ticks = historyTicks(ts, ts + 3600);
  assert.equal(ticks[0].day, '10/16');
  assert.equal(ticks[0].time, '00:00');
  assert.equal(ticks[1].time, '00:10');
  for (const invalid of ['2026-02-30T10:00', '2026-10-16', '', '2026-13-01T00:00']) {
    assert.equal(parseJstInput(invalid), null);
  }
});

test('previous and next move by exactly one selected span and cannot advance beyond the current window', () => {
  const now = 1700000000;
  for (const span of [90 * 86400, 30 * 86400, 7 * 86400, 86400, 3600]) {
    const current = { from: now - span, to: now, now };
    assert.equal(shiftedHistoryStart(current, 1), null);
    const previous = shiftedHistoryStart(current, -1)!;
    assert.equal(previous, now - span * 2);
    assert.equal(shiftedHistoryStart({ from: previous, to: previous + span, now }, 1), current.from);
  }
  assert.equal(shiftedHistoryStart({ from: 0, to: 3600, now }, -1), null);
});
