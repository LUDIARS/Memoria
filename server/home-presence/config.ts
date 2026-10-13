// 帰宅・出発通知の config / rule の永続化 (app_settings) と正規化。
// UI から来た任意入力は normalize* で型を矯正してから保存する。

import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';
import { normalizeTaskFilter } from '../shared/task-select.js';
import { DISCORD_CHANNEL_KINDS, type NotifyDestination } from '../shared/notify-sink.js';
import { PRESENCE_EVENTS, type HomePresenceConfig, type PresenceEvent, type PresenceRule } from './types.js';

type Db = BetterSqlite3.Database;

const KEY_CONFIG = 'features.home_presence.config';
const KEY_RULES = 'features.home_presence.rules';

export const DEFAULT_CONFIG: HomePresenceConfig = {
  enabled: false,
  nearRadiusM: 1000,
  hysteresisM: 50,
  staleMin: 15,
  cooldownMin: 10,
};

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(num(v, fallback))));
}
function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function normalizeConfig(v: unknown): HomePresenceConfig {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    nearRadiusM: clampInt(o.nearRadiusM, DEFAULT_CONFIG.nearRadiusM, 300, 5000),
    hysteresisM: clampInt(o.hysteresisM, DEFAULT_CONFIG.hysteresisM, 0, 300),
    staleMin: clampInt(o.staleMin, DEFAULT_CONFIG.staleMin, 1, 120),
    cooldownMin: clampInt(o.cooldownMin, DEFAULT_CONFIG.cooldownMin, 0, 180),
  };
}

function normEvent(v: unknown): PresenceEvent {
  return (PRESENCE_EVENTS as readonly unknown[]).includes(v) ? v as PresenceEvent : 'depart';
}

export function normalizeDestinations(v: unknown): NotifyDestination[] {
  const out: NotifyDestination[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(v) ? v : []) {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    let d: NotifyDestination | null = null;
    if (o.kind === 'line') d = { kind: 'line' };
    if (o.kind === 'discord') {
      const ch = typeof o.channel === 'string' && (DISCORD_CHANNEL_KINDS as readonly string[]).includes(o.channel)
        ? o.channel : 'announce';
      d = { kind: 'discord', channel: ch };
    }
    if (!d) continue;
    const key = JSON.stringify(d);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

export function normalizeRules(input: unknown): PresenceRule[] {
  const out: PresenceRule[] = [];
  for (const raw of Array.isArray(input) ? input : []) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    out.push({
      id: (typeof o.id === 'string' && o.id.trim()) || randomUUID(),
      name: (typeof o.name === 'string' ? o.name.trim().slice(0, 80) : '') || '帰宅・出発通知',
      enabled: o.enabled !== false,
      event: normEvent(o.event),
      message: typeof o.message === 'string' ? o.message.trim().slice(0, 200) : '',
      includeTasks: o.includeTasks !== false,
      filter: normalizeTaskFilter(o.filter),
      sendWhenEmpty: o.sendWhenEmpty === true,
      destinations: normalizeDestinations(o.destinations),
    });
  }
  return out;
}

export function loadConfig(db: Db): HomePresenceConfig {
  return normalizeConfig(parseJson(getAppSettings(db)[KEY_CONFIG]));
}

export function loadRules(db: Db): PresenceRule[] {
  return normalizeRules(parseJson(getAppSettings(db)[KEY_RULES]));
}

export function saveConfig(db: Db, config: HomePresenceConfig): void {
  setAppSettings(db, { [KEY_CONFIG]: JSON.stringify(config) });
}

export function saveRules(db: Db, rules: PresenceRule[]): void {
  setAppSettings(db, { [KEY_RULES]: JSON.stringify(rules) });
}

export function findRule(db: Db, id: string): PresenceRule | null {
  return loadRules(db).find((r) => r.id === id) ?? null;
}
