// 1 回分の評価: 自宅・最新 GPS・前回状態から event を決め、 状態を保存する。

import type BetterSqlite3 from 'better-sqlite3';
import { loadConfig } from './config.js';
import { resolveHome } from './home.js';
import { isFresh, readLatestFix } from './latest-fix.js';
import { classifyZone, haversineMeters } from './zone.js';
import { detectEvent } from './detect.js';
import { loadState, saveState } from './state.js';
import type { PresenceEvent } from './types.js';

type Db = BetterSqlite3.Database;

export type EvaluateSkip = 'disabled' | 'no_home' | 'no_gps' | 'stale_gps';

export interface EvaluateResult {
  event: PresenceEvent | null;
  skipped?: EvaluateSkip;
}

export function evaluatePresence(db: Db, now: number = Date.now()): EvaluateResult {
  const config = loadConfig(db);
  if (!config.enabled) return { event: null, skipped: 'disabled' };
  const home = resolveHome(db);
  if (!home) return { event: null, skipped: 'no_home' };
  const fix = readLatestFix(db);
  if (!fix) return { event: null, skipped: 'no_gps' };
  // 古い位置では判定も状態更新もしない (送信が止まった端末の古い位置で誤判定しない)
  if (!isFresh(fix, config.staleMin, now)) return { event: null, skipped: 'stale_gps' };

  const prev = loadState(db);
  const zone = classifyZone(haversineMeters(home, fix), prev?.zone ?? null, {
    homeM: home.radiusM,
    nearM: config.nearRadiusM,
    hysteresisM: config.hysteresisM,
  });
  const { event, next } = detectEvent(prev, zone, now, config.cooldownMin * 60_000);
  saveState(db, next);
  return { event };
}
