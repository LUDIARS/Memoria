// 通知トリガーの永続化 (app_settings `features.discord.notify.triggers` = JSON 配列)。
// UI から来た任意入力は normalizeTriggers で型を矯正してから保存する。

import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../../db.js';
import {
  NOTIFY_CHANNEL_KINDS,
  type DeadlineFilter,
  type NotifyFilter,
  type NotifyTrigger,
  type TriggerSpec,
} from './types.js';

type Db = BetterSqlite3.Database;

const KEY = 'features.discord.notify.triggers';

export function loadTriggers(db: Db): NotifyTrigger[] {
  const raw = getAppSettings(db)[KEY];
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? normalizeTriggers(arr) : [];
  } catch {
    return [];
  }
}

export function saveTriggers(db: Db, triggers: NotifyTrigger[]): void {
  setAppSettings(db, { [KEY]: JSON.stringify(triggers) });
}

export function findTrigger(db: Db, id: string): NotifyTrigger | null {
  return loadTriggers(db).find((t) => t.id === id) ?? null;
}

// ─── 正規化 (任意の unknown[] → NotifyTrigger[]) ───────────────────────────

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
/** "HH:MM" に矯正 (不正なら fallback)。 */
function hhmm(v: unknown, fallback: string): string {
  const s = str(v).trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return fallback;
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const mi = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function normSpec(v: unknown): TriggerSpec {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  if (o.type === 'random') {
    const w = Array.isArray(o.window) ? o.window : [];
    return {
      type: 'random',
      window: [hhmm(w[0], '09:00'), hhmm(w[1], '21:00')],
      count: Math.min(10, Math.max(1, Math.round(num(o.count, 1)))),
    };
  }
  if (o.type === 'gps') {
    return {
      type: 'gps',
      event: o.event === 'depart' ? 'depart' : 'arrive',
      radius_m: Math.min(5000, Math.max(50, Math.round(num(o.radius_m, 200)))),
    };
  }
  // 既定 time
  return { type: 'time', at: hhmm(o.at, '08:00') };
}

function normFilter(v: unknown): NotifyFilter {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const cats = Array.isArray(o.categories)
    ? o.categories.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim())
    : [];
  const deadline: DeadlineFilter = o.deadline === 'all' ? 'all' : 'due_today_or_overdue';
  return { categories: cats.length ? cats : ['all'], deadline };
}

function normChannel(v: unknown): string {
  const s = str(v, 'announce');
  return (NOTIFY_CHANNEL_KINDS as readonly string[]).includes(s) ? s : 'announce';
}

export function normalizeTriggers(input: unknown[]): NotifyTrigger[] {
  const out: NotifyTrigger[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    out.push({
      id: str(o.id).trim() || randomUUID(),
      name: str(o.name).trim().slice(0, 80) || '通知',
      enabled: o.enabled !== false,
      trigger: normSpec(o.trigger),
      filter: normFilter(o.filter),
      channel: normChannel(o.channel),
    });
  }
  return out;
}
