// Midnight + Sunday-evening cron schedulers, plus the daily task reminder.
//
// すべて setTimeout / setInterval ベースで、 process が生きている間だけ動く。
// Memoria の運用形態 (個人 PC で常駐) ではこれで十分。

import type BetterSqlite3 from 'better-sqlite3';
import { yesterdayLocal, formatLocalDate, weekRangeFor } from '../diary.js';
import { listTasks, getAppSettings, setAppSettings } from '../db.js';
import { sendPushToAll } from '../push.js';
import { featureEnabled } from './privacy.js';

type Db = BetterSqlite3.Database;

export interface SchedulerDeps {
  db: Db;
  enqueueDiary: (dateStr: string) => void;
  enqueueWeekly: (weekStart: string) => void;
  /** privacySettings() を呼べるように渡す。 settings を毎回読みたいので関数渡し */
  getPrivacySettings: () => {
    tasks_reminder_enabled: boolean;
    tasks_reminder_hour: number;
    tasks_reminder_minute: number;
    tasks_reminder_nuntius_enabled: boolean;
    tasks_reminder_nuntius_url: string;
  };
}

export function startSchedulers(deps: SchedulerDeps): void {
  scheduleMidnight(deps);
  scheduleSundayEvening(deps);
  startTaskReminderInterval(deps);
}

// Midnight scheduler — fires at next 00:00:05 local, generates the previous
// day's diary, then re-schedules itself.
function scheduleMidnight(deps: SchedulerDeps): void {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  const ms = next.getTime() - now.getTime();
  setTimeout(() => {
    try {
      // `features.diary.auto_generate` で OFF にできる (= 「日記生成」 ボタンの
      // 手動操作だけが残る)。 cron 自体は走り続けて、 enqueue を skip する。
      if (!featureEnabled(deps.db, 'diary_auto_generate')) {
        console.log('[diary cron] skipped (features.diary.auto_generate=false)');
      } else {
        const dateStr = yesterdayLocal();
        console.log(`[diary cron] generating ${dateStr}`);
        deps.enqueueDiary(dateStr);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[diary cron] failed:', msg);
    }
    scheduleMidnight(deps);
  }, Math.max(60_000, ms)).unref?.();
}

// Sunday 23:00 cron — summarises Mon-Sun of the current week.
function scheduleSundayEvening(deps: SchedulerDeps): void {
  const now = new Date();
  const next = new Date(now);
  const dow = now.getDay();
  const daysUntilSunday = dow === 0 ? 0 : (7 - dow); // 0=Sun,1=Mon,...6=Sat
  next.setDate(now.getDate() + daysUntilSunday);
  next.setHours(23, 0, 5, 0);
  if (next <= now) next.setDate(next.getDate() + 7);
  const ms = next.getTime() - now.getTime();
  setTimeout(() => {
    try {
      if (!featureEnabled(deps.db, 'diary_auto_generate')) {
        console.log('[weekly cron] skipped (features.diary.auto_generate=false)');
      } else {
        const today = new Date();
        const range = weekRangeFor(formatLocalDate(today));
        console.log(`[weekly cron] generating week ${range.start}`);
        deps.enqueueWeekly(range.start);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[weekly cron] failed:', msg);
    }
    scheduleSundayEvening(deps);
  }, Math.max(60_000, ms)).unref?.();
}

// Task reminder: 1分ごとに時刻チェック、当日初回のみ送信
function startTaskReminderInterval(deps: SchedulerDeps): void {
  setInterval(async () => {
    try {
      const s = deps.getPrivacySettings();
      if (!s.tasks_reminder_enabled) return;
      const now = new Date();
      if (now.getHours() !== s.tasks_reminder_hour || now.getMinutes() !== s.tasks_reminder_minute) return;
      const today = now.toISOString().slice(0, 10);
      const appS = getAppSettings(deps.db);
      if (appS['tasks.reminder.last_sent_date'] === today) return;

      const tasks = [
        ...listTasks(deps.db, { status: 'todo', limit: 20 }),
        ...listTasks(deps.db, { status: 'doing', limit: 20 }),
      ];
      if (!tasks.length) {
        setAppSettings(deps.db, { 'tasks.reminder.last_sent_date': today });
        return;
      }

      const todoCount = tasks.filter((t) => t.status === 'todo').length;
      const doingCount = tasks.filter((t) => t.status === 'doing').length;
      const preview = tasks.slice(0, 5).map((t) => `・${t.title.slice(0, 50)}`).join('\n');
      const more = tasks.length > 5 ? `\n…他 ${tasks.length - 5} 件` : '';
      const pushBody = `todo: ${todoCount} 件, 進行中: ${doingCount} 件\n${preview}${more}`;

      await sendPushToAll(deps.db, { title: '📋 本日のタスクリマインド', body: pushBody })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('[reminder] push failed:', msg);
        });

      if (s.tasks_reminder_nuntius_enabled && s.tasks_reminder_nuntius_url) {
        await fetch(s.tasks_reminder_nuntius_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: '📋 本日のタスクリマインド', body: pushBody }),
          signal: AbortSignal.timeout(10_000),
        }).catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('[reminder] nuntius failed:', msg);
        });
      }

      setAppSettings(deps.db, { 'tasks.reminder.last_sent_date': today });
      console.log(`[reminder] sent for ${today}: ${tasks.length} task(s)`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[reminder] unexpected error:', msg);
    }
  }, 60_000).unref?.();
}
