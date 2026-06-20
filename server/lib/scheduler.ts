// Midnight + Sunday-evening cron schedulers, plus the daily task reminder.
//
// すべて setTimeout / setInterval ベースで、 process が生きている間だけ動く。
// Memoria の運用形態 (個人 PC で常駐) ではこれで十分。

import type BetterSqlite3 from 'better-sqlite3';
import { yesterdayLocal, formatLocalDate, weekRangeFor } from '../diary.js';
import { listTasks, getAppSettings, setAppSettings } from '../db.js';
import { sendPushToAll } from '../push.js';
import { featureEnabled } from './privacy.js';
import {
  fetchForecast, insertWeatherSnapshot, readLatestGpsLatLon,
  isRainingNow, nextRainStart, describeCode,
} from './weather.js';
import { runDetection as runTransitDetection } from './transit-detect.js';
import { pollAllFeeds, getRssConfig } from '../rss/index.js';
import type { BlackBoxEngine } from '../blackbox/index.js';
import { getWeatherConfig } from '../weather/config.js';
import { buildBriefing, formatBriefingPush } from '../weather/briefing.js';
import { startBriefingScheduler } from '../briefing/index.js';
import { startGoalEvalScheduler } from '../goals/eval-scheduler.js';
import { startAiHubSchedulers } from '../ai-hub/index.js';

type Db = BetterSqlite3.Database;

export interface SchedulerDeps {
  db: Db;
  /** 成長型ブラックボックス engine (朝の雨ブリーフィングで雨判定に使う)。 */
  blackbox: BlackBoxEngine;
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
  startWeatherRainAlertInterval(deps);
  startWeatherMorningBriefingInterval(deps);
  startTransitDetectionInterval(deps);
  startRssPollInterval(deps);
  startBriefingScheduler(deps.db);
  startGoalEvalScheduler(deps.db);
  startAiHubSchedulers(deps.db);
}

// 朝の雨ブリーフィング — 1 分おきに時刻を見て、 設定時刻 (既定 7:00) に当日 1 回だけ、
// 対象地点 (自宅 + 行きがちな場所) をマルチソースで検証し、 雨があれば push。
// 「いま雨」 アラート (startWeatherRainAlertInterval) とは別系統のマルチソース版。
function startWeatherMorningBriefingInterval(deps: SchedulerDeps): void {
  const tick = async () => {
    try {
      if (!featureEnabled(deps.db, 'weather_enabled')) return;
      const cfg = getWeatherConfig(deps.db);
      if (!cfg.briefing.enabled) return;

      const now = new Date();
      if (now.getHours() !== cfg.briefing.hour || now.getMinutes() !== 0) return;

      const today = formatLocalDate(now);
      const appS = getAppSettings(deps.db);
      if (appS['weather.morning_briefing.last_sent_date'] === today) return;

      const briefing = await buildBriefing(deps.db, deps.blackbox, now);
      const payload = formatBriefingPush(briefing, cfg.briefing.notifyWhenClear);
      // 送信有無に関わらず当日分は処理済みにする (雨ゼロでも再計算を避ける)。
      setAppSettings(deps.db, { 'weather.morning_briefing.last_sent_date': today });
      if (!payload) {
        console.log(`[weather briefing] ${today}: 雨なし — 送信スキップ`);
        return;
      }
      await sendPushToAll(deps.db, {
        title: payload.title, body: payload.body,
        tag: `memoria-weather-briefing-${today}`, url: '/?tab=weather',
      }).catch((e: unknown) => console.error('[weather briefing] push failed:', e instanceof Error ? e.message : String(e)));
      console.log(`[weather briefing] sent for ${today}: ${payload.title}`);
    } catch (e: unknown) {
      console.warn('[weather briefing] tick failed:', e instanceof Error ? e.message : String(e));
    }
  };
  // 起動 20s 後に 1 回 (起動が briefing 時刻ちょうどなら拾う)、 以後 1 分おき。
  setTimeout(() => { void tick(); }, 20_000).unref?.();
  setInterval(() => { void tick(); }, 60_000).unref?.();
}

// RSS / トレンド取り込み — rss.poll_interval_minutes おきに全フィードを
// 取得 → 新着を AI 採点 → 閾値以上を push。 設定で OFF にできる。
// 多重起動は pollAllFeeds 側の in-flight guard が防ぐ。
function startRssPollInterval(deps: SchedulerDeps): void {
  // 設定間隔を毎 tick 読み直す。 最小 5 分を内部で 1 分刻みに丸めるため、
  // 1 分ごとに「前回から interval 経過したか」 を判定する素朴方式。
  let lastRun = 0;
  const tick = async () => {
    try {
      const cfg = getRssConfig(deps.db);
      if (!cfg.enabled) return;
      const intervalMs = Math.max(5, cfg.poll_interval_minutes) * 60 * 1000;
      const now = Date.now();
      if (now - lastRun < intervalMs) return;
      lastRun = now;
      const r = await pollAllFeeds(deps.db);
      if (r.newArticles > 0 || r.notified > 0) {
        console.log(`[rss] poll: feeds=${r.feeds} new=${r.newArticles} scored=${r.scored} notified=${r.notified}`);
      }
    } catch (e: unknown) {
      console.warn('[rss] poll tick failed:', e instanceof Error ? e.message : String(e));
    }
  };
  // 起動 45s 後に初回 (lastRun=0 なので即走る)、 以後 1 分ごとに判定。
  setTimeout(() => { void tick(); }, 45_000).unref?.();
  setInterval(() => { void tick(); }, 60_000).unref?.();
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

// 「日中に晴れ → 雨」 通知。 30 分おきに forecast を fetch して、
//   - 今日まだ雨アラートを送っていない
//   - かつ 「今 raining」 or 「これから lookAheadHours 以内に雨」
// のとき 1 回だけ push。 cron は process が生きている間ずっと走る。
//
// 朝 5 時 -> 22 時の活動時間帯だけ動かす (深夜の通知音を避ける)。
function startWeatherRainAlertInterval(deps: SchedulerDeps): void {
  const INTERVAL_MS = 30 * 60 * 1000;     // 30 min
  const ACTIVE_HOUR_START = 5;
  const ACTIVE_HOUR_END = 22;             // 22:00 まで

  const tick = async () => {
    try {
      if (!featureEnabled(deps.db, 'weather_enabled')) return;
      if (!featureEnabled(deps.db, 'weather_rain_alert_enabled')) return;

      const now = new Date();
      const hour = now.getHours();
      if (hour < ACTIVE_HOUR_START || hour >= ACTIVE_HOUR_END) return;

      const today = formatLocalDate(now);
      const appS = getAppSettings(deps.db);
      const lastSentDate = appS['weather.rain_alert.last_sent_date'];
      // 既に同じ日に送っていれば skip
      if (lastSentDate === today) return;

      // 位置解決: 固定 lat/lon > GPS 最新。 どちらも無ければ skip。
      const fLat = Number(appS['weather.fixed_lat']);
      const fLon = Number(appS['weather.fixed_lon']);
      let loc: { lat: number; lon: number } | null = null;
      if (Number.isFinite(fLat) && Number.isFinite(fLon) && (fLat !== 0 || fLon !== 0)) {
        loc = { lat: fLat, lon: fLon };
      } else {
        loc = readLatestGpsLatLon(deps.db);
      }
      if (!loc) return;

      const forecast = await fetchForecast(loc.lat, loc.lon);
      insertWeatherSnapshot(deps.db, today, forecast);

      const raining = isRainingNow(forecast);
      const nextStart = nextRainStart(forecast, { todayDateLocal: today, lookAheadHours: 6 });

      // 「日中に晴れ→雨」 = いま晴れてて、 今後 6h 以内に降水予報。
      // 「降っている」 = いま既に降水中。
      let title = '';
      let body = '';
      if (raining) {
        const c = forecast.current!;
        const desc = describeCode(c.weather_code);
        title = `${desc.icon} 雨が降っています`;
        body = `${desc.label} (降水 ${c.precipitation.toFixed(1)}mm) — 外出時は傘を`;
      } else if (nextStart) {
        const t = new Date(nextStart);
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        // どのコードで降る予想か (= hourly の該当 index)
        const idx = forecast.hourly.time.indexOf(nextStart);
        const code = idx >= 0 ? forecast.hourly.weather_code[idx] : 61;
        const desc = describeCode(code);
        const prob = idx >= 0 ? forecast.hourly.precipitation_probability[idx] : null;
        const probStr = prob != null ? ` (降水確率 ${prob}%)` : '';
        title = `${desc.icon} ${hh}:${mm} 頃から${desc.label}`;
        body = `今日この後${desc.label}の予報${probStr} — 出発前に傘の用意を`;
      } else {
        return;   // 今日は雨無し
      }

      await sendPushToAll(deps.db, {
        title,
        body,
        tag: `memoria-weather-rain-${today}`,
        url: '/?tab=weather',
      }).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[weather alert] push failed:', msg);
      });
      setAppSettings(deps.db, { 'weather.rain_alert.last_sent_date': today });
      console.log(`[weather alert] sent for ${today}: ${title}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Open-Meteo の一時的な失敗は log だけ、 次の tick で retry。
      console.warn('[weather alert] tick failed:', msg);
    }
  };

  // 起動直後にも 1 回 (= 朝起動して即チェック)、 以後 30 分おき。
  setTimeout(() => { void tick(); }, 15_000).unref?.();
  setInterval(() => { void tick(); }, INTERVAL_MS).unref?.();
}

// 乗車自動検出 — 1 時間おきに直近 24h の GPS を走査して transit_rides に
// 確定済み window を append。 完了したばかりの移動 (= 終端 settled に MIN_SETTLED_MS
// 経過) を拾う設計なので、 cron 間隔と settled しきい値が同等以下なら漏れない。
function startTransitDetectionInterval(deps: SchedulerDeps): void {
  const INTERVAL_MS = 60 * 60 * 1000;
  const tick = async () => {
    try {
      if (!featureEnabled(deps.db, 'tracks_enabled')) return;
      const since = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
      const r = await runTransitDetection(deps.db, { since });
      if (r.inserted > 0) {
        console.log(`[transit-detect] inserted ${r.inserted} (scanned=${r.scanned} windows=${r.windows} dup=${r.skipped_dup})`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[transit-detect] tick failed:', msg);
    }
  };
  // 起動から 30s 後に 1 度走らせて以後 1 時間おき。
  setTimeout(() => { void tick(); }, 30_000).unref?.();
  setInterval(() => { void tick(); }, INTERVAL_MS).unref?.();
}
