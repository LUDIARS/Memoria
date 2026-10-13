// 判定状態 (前回 zone・event ごとの最終発火) の永続化。 再起動を跨いで誤発火しないよう app_settings に置く。

import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';
import { PRESENCE_EVENTS, type PresenceState, type Zone } from './types.js';

type Db = BetterSqlite3.Database;

const KEY_STATE = 'features.home_presence.state';
const ZONES: readonly Zone[] = ['home', 'near', 'away'];

export function parseState(raw: string | null | undefined): PresenceState | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!ZONES.includes(o.zone as Zone)) return null;
    const last = (o.lastEventAt && typeof o.lastEventAt === 'object' ? o.lastEventAt : {}) as Record<string, unknown>;
    const lastEventAt: PresenceState['lastEventAt'] = {};
    for (const ev of PRESENCE_EVENTS) {
      if (typeof last[ev] === 'number' && Number.isFinite(last[ev])) lastEventAt[ev] = last[ev] as number;
    }
    return { zone: o.zone as Zone, lastEventAt };
  } catch {
    return null;
  }
}

export function loadState(db: Db): PresenceState | null {
  return parseState(getAppSettings(db)[KEY_STATE]);
}

export function saveState(db: Db, state: PresenceState): void {
  setAppSettings(db, { [KEY_STATE]: JSON.stringify(state) });
}

/** 自宅を変えたときなど、 基準から取り直す。 */
export function clearState(db: Db): void {
  setAppSettings(db, { [KEY_STATE]: '' });
}
