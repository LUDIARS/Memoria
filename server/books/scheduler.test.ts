// 週次スケジューラの発火条件。 週に 1 回だけ、 失敗週は再試行できることを見る。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { DEFAULT_BOOKS_CONFIG } from './config.js';
import { runWeeklyBooksJob, shouldRunWeekly, weekKey } from './scheduler.js';

// 2026-09-07 は月曜。 既定設定 (weeklyDay=1 月曜 / weeklyHour=8)。
const MONDAY_9AM = new Date('2026-09-07T09:00:00');
const MONDAY_7AM = new Date('2026-09-07T07:00:00');
const WEDNESDAY = new Date('2026-09-09T09:00:00');

test('weekKey は巡回曜日を起点にした週の始まり日', () => {
  assert.equal(weekKey(DEFAULT_BOOKS_CONFIG, MONDAY_9AM), '2026-09-07');
  assert.equal(weekKey(DEFAULT_BOOKS_CONFIG, WEDNESDAY), '2026-09-07');
});

test('巡回曜日の設定時刻を過ぎたら走る', () => {
  assert.equal(shouldRunWeekly(DEFAULT_BOOKS_CONFIG, null, MONDAY_9AM, 0), true);
  assert.equal(shouldRunWeekly(DEFAULT_BOOKS_CONFIG, null, MONDAY_7AM, 0), false);
});

test('その週に走り終えていたら走らない', () => {
  assert.equal(shouldRunWeekly(DEFAULT_BOOKS_CONFIG, '2026-09-07', WEDNESDAY, 0), false);
  assert.equal(shouldRunWeekly(DEFAULT_BOOKS_CONFIG, '2026-08-31', WEDNESDAY, 0), true);
});

test('直近の試行から間隔が空くまで再試行しない', () => {
  const justTried = WEDNESDAY.getTime() - 60_000;
  assert.equal(shouldRunWeekly(DEFAULT_BOOKS_CONFIG, null, WEDNESDAY, justTried), false);
});

test('無効化されていたら走らない', () => {
  assert.equal(shouldRunWeekly({ ...DEFAULT_BOOKS_CONFIG, enabled: false }, null, MONDAY_9AM, 0), false);
});

test('書誌ソース障害は週次ジョブの成功にしない', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
  await assert.rejects(() => runWeeklyBooksJob(db, MONDAY_9AM, {
    checkNewReleases: async () => ({
      checkedTargets: 1,
      found: [],
      errors: ['ndl failed: offline'],
      ranAt: MONDAY_9AM.toISOString(),
    }),
  }), /new-release sources failed/);
});
