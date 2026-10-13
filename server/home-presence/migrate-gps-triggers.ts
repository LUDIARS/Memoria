// 旧 Discord 通知トリガーの gps 種別 (帰宅/出発) を home-presence の rule へ 1 回だけ移す。
// Discord トリガーの保存値は app_settings の JSON なので、 discord ドメインを import せず保存値を直接読み書きする。

import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';
import { loadConfig, loadRules, normalizeRules, saveConfig, saveRules } from './config.js';
import type { PresenceRule } from './types.js';

type Db = BetterSqlite3.Database;

const KEY_DISCORD_TRIGGERS = 'features.discord.notify.triggers';
const KEY_DONE = 'features.home_presence.migrated_gps_triggers';

interface SplitResult {
  rules: PresenceRule[];
  /** gps 以外の旧トリガー (保存値のまま)。 */
  rest: unknown[];
}

/** 旧トリガー配列を gps (→ rule) とそれ以外に分ける (純関数)。 */
export function splitGpsTriggers(raw: unknown[]): SplitResult {
  const gpsLike: unknown[] = [];
  const rest: unknown[] = [];
  for (const t of raw) {
    const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
    const spec = (o.trigger && typeof o.trigger === 'object' ? o.trigger : {}) as Record<string, unknown>;
    if (spec.type !== 'gps') {
      rest.push(t);
      continue;
    }
    gpsLike.push({
      id: o.id,
      name: o.name,
      enabled: o.enabled,
      event: spec.event === 'depart' ? 'depart' : 'arrive',
      message: '',
      includeTasks: true,
      filter: o.filter,
      // 旧トリガーは該当 0 件のとき送らなかった
      sendWhenEmpty: false,
      destinations: [{ kind: 'discord', channel: typeof o.channel === 'string' ? o.channel : 'announce' }],
    });
  }
  return { rules: normalizeRules(gpsLike), rest };
}

/** 移行を 1 回だけ行う。 移した件数を返す。 */
export function migrateGpsTriggers(db: Db): number {
  const s = getAppSettings(db);
  if (s[KEY_DONE] === '1') return 0;
  let raw: unknown = null;
  try { raw = s[KEY_DISCORD_TRIGGERS] ? JSON.parse(s[KEY_DISCORD_TRIGGERS]) : null; } catch { raw = null; }
  if (!Array.isArray(raw)) {
    setAppSettings(db, { [KEY_DONE]: '1' });
    return 0;
  }
  const { rules, rest } = splitGpsTriggers(raw);
  if (rules.length) {
    const existing = loadRules(db);
    const ids = new Set(existing.map((r) => r.id));
    saveRules(db, [...existing, ...rules.filter((r) => !ids.has(r.id))]);
    // 旧トリガーが動いていたなら新しい判定も ON にして挙動を引き継ぐ
    if (rules.some((r) => r.enabled)) saveConfig(db, { ...loadConfig(db), enabled: true });
  }
  setAppSettings(db, {
    [KEY_DISCORD_TRIGGERS]: JSON.stringify(rest),
    [KEY_DONE]: '1',
  });
  return rules.length;
}
