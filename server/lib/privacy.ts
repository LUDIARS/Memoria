// privacy / feature flags の集約。 settings table から bool / number を読み出す。
// すべての feature flag は app_settings テーブルにキー名で保存されており、
// このモジュールが正規化された形で返す。

import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings } from '../db.js';

type Db = BetterSqlite3.Database;

export interface PrivacySettings {
  tracks_enabled: boolean;
  tracks_visible: boolean;
  meals_enabled: boolean;
  meals_visible: boolean;
  tasks_actio_share_enabled: boolean;
  actio_share_url: string;
  tasks_reminder_enabled: boolean;
  tasks_reminder_hour: number;
  tasks_reminder_minute: number;
  tasks_reminder_nuntius_enabled: boolean;
  tasks_reminder_nuntius_url: string;
  mcp_autostart_enabled: boolean;
  workplace_geo_enabled: boolean;
  workplace_auto_share_enabled: boolean;
  workplace_match_radius_m: number;
}

export type PrivacyBoolKey = keyof Pick<PrivacySettings,
  | 'tracks_enabled' | 'tracks_visible'
  | 'meals_enabled' | 'meals_visible'
  | 'tasks_actio_share_enabled' | 'tasks_reminder_enabled'
  | 'tasks_reminder_nuntius_enabled' | 'mcp_autostart_enabled'
  | 'workplace_geo_enabled' | 'workplace_auto_share_enabled'
>;

export function settingBool(settings: Record<string, string | null>, key: string, fallback = true): boolean {
  const v = settings[key];
  if (v == null || v === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(v).toLowerCase());
}

export function privacySettings(db: Db): PrivacySettings {
  const s = getAppSettings(db);
  return {
    tracks_enabled: settingBool(s, 'features.tracks.enabled', true),
    tracks_visible: settingBool(s, 'features.tracks.visible', true),
    meals_enabled: settingBool(s, 'features.meals.enabled', true),
    meals_visible: settingBool(s, 'features.meals.visible', true),
    tasks_actio_share_enabled: settingBool(s, 'features.tasks.actio_share.enabled', true),
    actio_share_url: s['actio.share_url'] || '',
    tasks_reminder_enabled: settingBool(s, 'features.tasks.reminder.enabled', true),
    tasks_reminder_hour: Number(s['features.tasks.reminder.hour'] ?? 6),
    tasks_reminder_minute: Number(s['features.tasks.reminder.minute'] ?? 0),
    tasks_reminder_nuntius_enabled: settingBool(s, 'features.tasks.reminder.nuntius_enabled', false),
    tasks_reminder_nuntius_url: s['features.tasks.reminder.nuntius_url'] || '',
    mcp_autostart_enabled: settingBool(s, 'features.mcp.autostart.enabled', false),
    workplace_geo_enabled: settingBool(s, 'features.workplace.geo.enabled', true),
    workplace_auto_share_enabled: settingBool(s, 'features.workplace.share.enabled', false),
    // OwnTracks の locator displacement と整合させやすい 50m を既定に。
    // 屋内ビルや GPS が荒い環境では 100-200m に上げる。
    workplace_match_radius_m: Number(s['features.workplace.match.radius_m'] ?? 50),
  };
}

export function featureEnabled(db: Db, key: PrivacyBoolKey): boolean {
  return privacySettings(db)[key] !== false;
}
