// 週次の新刊チェック。 設定曜日の設定時刻を過ぎたら、 その週 1 回だけ回す。
// 失敗した週は 6 時間おきに再試行する (PC が寝ていた週を落とさないため)。

import type BetterSqlite3 from 'better-sqlite3';
import { getBooksConfig } from './config.js';
import { booksJobCoordinator } from './coordinator.js';
import { checkNewReleases, type NewReleaseCheckResult } from './new-release.js';
import { generateSuggestions } from './suggest.js';
import type { BooksConfig } from './types.js';

type Db = BetterSqlite3.Database;

const RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LAST_RUN_KEY = 'books.last_weekly_run';

function readLastRun(db: Db): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(LAST_RUN_KEY) as
    { value: string | null } | undefined;
  return row?.value ?? null;
}

function writeLastRun(db: Db, week: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(LAST_RUN_KEY, week);
}

/** その日を含む週の識別子 (巡回曜日を起点にした週の始まり日)。 */
export function weekKey(config: BooksConfig, now: Date): string {
  const start = new Date(now);
  const diff = (now.getDay() - config.weeklyDay + 7) % 7;
  start.setDate(start.getDate() - diff);
  const y = start.getFullYear();
  const m = String(start.getMonth() + 1).padStart(2, '0');
  const d = String(start.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function shouldRunWeekly(
  config: BooksConfig,
  lastRunWeek: string | null,
  now: Date,
  lastAttemptAt: number,
): boolean {
  if (!config.enabled) return false;
  const current = weekKey(config, now);
  if (lastRunWeek === current) return false;
  // 週の開始曜日そのものに達していない (= 前の週の判定) 間は待つ。
  if (now.getDay() === config.weeklyDay && now.getHours() < config.weeklyHour) return false;
  return now.getTime() - lastAttemptAt >= RETRY_INTERVAL_MS;
}

export interface WeeklyRunResult {
  newReleases: NewReleaseCheckResult;
  suggestionCount: number;
}

export interface WeeklyJobDeps {
  checkNewReleases?: typeof checkNewReleases;
  generateSuggestions?: typeof generateSuggestions;
}

/** 新刊チェック → サジェスト再生成。 手動実行 (Discord / 画面) からも呼ぶ。 */
export async function runWeeklyBooksJob(
  db: Db,
  now: Date = new Date(),
  deps: WeeklyJobDeps = {},
): Promise<WeeklyRunResult> {
  const config = getBooksConfig(db);
  const newReleases = await (deps.checkNewReleases ?? checkNewReleases)(db, config, now);
  if (newReleases.errors.length > 0) {
    throw new Error(`new-release sources failed: ${newReleases.errors.join('; ')}`);
  }
  const suggestionRequest = booksJobCoordinator.request('suggest', () => (
    (deps.generateSuggestions ?? generateSuggestions)(db, config, now)
  ));
  const suggested = await suggestionRequest.promise;
  if (suggested.errors.length > 0) {
    throw new Error(`suggestion sources failed: ${suggested.errors.join('; ')}`);
  }
  return { newReleases, suggestionCount: suggested.suggestions.length };
}

export function startBooksScheduler(db: Db): void {
  let lastAttemptAt = 0;
  const tick = async (): Promise<void> => {
    try {
      const now = new Date();
      const config = getBooksConfig(db);
      if (!shouldRunWeekly(config, readLastRun(db), now, lastAttemptAt)) return;
      lastAttemptAt = now.getTime();
      const request = booksJobCoordinator.request('new_release', () => runWeeklyBooksJob(db, now));
      if (request.status === 'busy') return;
      await request.promise;
      writeLastRun(db, weekKey(config, now));
    } catch (error: unknown) {
      console.warn('[books] weekly job failed:', error instanceof Error ? error.message : String(error));
    }
  };
  setTimeout(() => { void tick(); }, 60_000).unref?.();
  setInterval(() => { void tick(); }, 10 * 60_000).unref?.();
}
