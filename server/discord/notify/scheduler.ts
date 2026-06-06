import type { Client } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../../db.js';
import { formatLocalDate } from '../../diary.js';
import { discordSettings } from '../settings.js';
import { loadTriggers } from './config.js';
import { detectHomeTransition } from './geofence.js';
import { fireTrigger } from './engine.js';
import { startDailyTaskReview } from './daily-review.js';
import type { NotifyTrigger, RandomSpec } from './types.js';

type Db = BetterSqlite3.Database;

function hhmmNow(now: Date): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function triggerFingerprint(t: NotifyTrigger): string {
  return Buffer.from(JSON.stringify({ trigger: t.trigger, filter: t.filter, channel: t.channel }))
    .toString('base64')
    .replace(/=+$/g, '')
    .slice(0, 24);
}

const firedKey = (t: NotifyTrigger) => `features.discord.notify.fired.${t.id}.${triggerFingerprint(t)}`;

interface RandomPlan { date: string; times: string[]; fired: string[] }
const randomKey = (t: NotifyTrigger) => `features.discord.notify.random.${t.id}.${triggerFingerprint(t)}`;

function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

function fromMinutes(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const mi = min % 60;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

export function pickRandomTimes(spec: RandomSpec): string[] {
  const start = toMinutes(spec.window[0]);
  const end = toMinutes(spec.window[1]);
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const span = Math.max(0, hi - lo);
  const n = Math.min(spec.count, span + 1);
  const set = new Set<number>();
  let guard = 0;
  while (set.size < n && guard < 1000) {
    set.add(lo + Math.floor(Math.random() * (span + 1)));
    guard += 1;
  }
  return [...set].sort((a, b) => a - b).map(fromMinutes);
}

function loadRandomPlan(db: Db, t: NotifyTrigger): RandomPlan | null {
  const raw = getAppSettings(db)[randomKey(t)];
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as RandomPlan;
    if (typeof p?.date === 'string' && Array.isArray(p.times) && Array.isArray(p.fired)) return p;
  } catch {
    // ignore
  }
  return null;
}

function ensureRandomPlan(db: Db, t: NotifyTrigger, spec: RandomSpec, today: string): RandomPlan {
  const cur = loadRandomPlan(db, t);
  if (cur && cur.date === today) return cur;
  const plan: RandomPlan = { date: today, times: pickRandomTimes(spec), fired: [] };
  setAppSettings(db, { [randomKey(t)]: JSON.stringify(plan) });
  return plan;
}

async function minuteTick(client: Client, db: Db): Promise<void> {
  if (!discordSettings(db).enabled) return;
  const now = new Date();
  const hhmm = hhmmNow(now);
  const today = formatLocalDate(now);
  const triggers = loadTriggers(db).filter((t) => t.enabled);

  for (const t of triggers) {
    try {
      if (t.trigger.type === 'time') {
        if (t.trigger.at !== hhmm) continue;
        if (getAppSettings(db)[firedKey(t)] === today) continue;
        await fireTrigger(client, db, t);
        if (t.filter.deadline === 'due_today_or_overdue') {
          await startDailyTaskReview(client, db, t.filter, t.channel, now);
        }
        setAppSettings(db, { [firedKey(t)]: today });
      } else if (t.trigger.type === 'random') {
        const plan = ensureRandomPlan(db, t, t.trigger, today);
        const nowMin = toMinutes(hhmm);
        const due = plan.times.filter((tm) => toMinutes(tm) <= nowMin && !plan.fired.includes(tm));
        if (!due.length) continue;
        await fireTrigger(client, db, t);
        plan.fired.push(...due);
        setAppSettings(db, { [randomKey(t)]: JSON.stringify(plan) });
      }
    } catch (e: unknown) {
      console.warn(`[notify] trigger ${t.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function gpsTick(client: Client, db: Db): Promise<void> {
  if (!discordSettings(db).enabled) return;
  const gps = loadTriggers(db).filter((t) => t.enabled && t.trigger.type === 'gps');
  if (!gps.length) return;
  const radius = Math.min(...gps.map((t) => (t.trigger.type === 'gps' ? t.trigger.radius_m : 200)));
  const ev = detectHomeTransition(db, radius);
  if (!ev) return;
  for (const t of gps) {
    if (t.trigger.type === 'gps' && t.trigger.event === ev) {
      try {
        await fireTrigger(client, db, t);
      } catch (e: unknown) {
        console.warn(`[notify] gps trigger ${t.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

export function startNotifyScheduler(client: Client, db: Db): void {
  setInterval(() => { void minuteTick(client, db); }, 60_000).unref?.();
  setTimeout(() => { void gpsTick(client, db); }, 25_000).unref?.();
  setInterval(() => { void gpsTick(client, db); }, 5 * 60_000).unref?.();
  console.log('[notify] task-notify scheduler started');
}

export type { NotifyTrigger };
