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
  /** 移動速度の閾値 (km/h)。 これより速い瞬間速度の GPS 点は「移動中」 とみなして
   *  workplace タグ付けの対象から外す (= 通り過ぎただけの場所を誤検出しない)。
   *  既定 5 km/h。 0 にすると速度フィルタ無効。 */
  workplace_max_speed_kmh: number;
  legatus_enabled: boolean;
  // AI 自動処理の opt-out 群。 すべて default true (= 現状維持) で、
  // ローカル運用ユーザは個別に OFF にして「素材は溜まる、 AI は呼ばない」
  // 状態を作る。
  bookmarks_auto_summarize: boolean;
  page_metadata_auto_fetch: boolean;
  domain_catalog_auto_classify: boolean;
  meals_auto_vision: boolean;
  diary_auto_generate: boolean;
  // PC 活動 / Steam 取り込み。 どちらも default false (= 明示 opt-in)。
  activity_app_sampling_enabled: boolean;
  activity_steam_enabled: boolean;
}

export type PrivacyBoolKey = keyof Pick<PrivacySettings,
  | 'tracks_enabled' | 'tracks_visible'
  | 'meals_enabled' | 'meals_visible'
  | 'tasks_actio_share_enabled' | 'tasks_reminder_enabled'
  | 'tasks_reminder_nuntius_enabled' | 'mcp_autostart_enabled'
  | 'workplace_geo_enabled' | 'workplace_auto_share_enabled'
  | 'legatus_enabled'
  | 'bookmarks_auto_summarize' | 'page_metadata_auto_fetch'
  | 'domain_catalog_auto_classify' | 'meals_auto_vision'
  | 'diary_auto_generate'
  | 'activity_app_sampling_enabled' | 'activity_steam_enabled'
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
    // place ごとの radius_m が work_locations に設定されていればそちらが優先。
    workplace_match_radius_m: Number(s['features.workplace.match.radius_m'] ?? 50),
    // 移動速度の閾値 (km/h)。 0 = フィルタ無効。 既定 5 km/h は徒歩上限近辺。
    workplace_max_speed_kmh: Number(s['features.workplace.max_speed_kmh'] ?? 5),
    // Legatus 連携は明示 opt-in。 default OFF (= 旧 Legatus 同居 PC を持たないユーザは
    // 何も気にせず UI から消える)。
    legatus_enabled: settingBool(s, 'features.legatus.enabled', false),
    // AI 自動処理。 default true (= 現状動作維持)。 すべて OFF で claude / OpenAI を
    // 一切自発的に呼ばないモードに切り替え可。 手動の「再要約」「dig」「日記生成
    // ボタン」 等の明示的トリガは引き続き動く (これらは UI ボタン → /api/.../resummarize
    // など別経路)。
    bookmarks_auto_summarize: settingBool(s, 'features.bookmarks.auto_summarize', true),
    page_metadata_auto_fetch: settingBool(s, 'features.page_metadata.auto_fetch', true),
    domain_catalog_auto_classify: settingBool(s, 'features.domain_catalog.auto_classify', true),
    meals_auto_vision: settingBool(s, 'features.meals.auto_vision', true),
    diary_auto_generate: settingBool(s, 'features.diary.auto_generate', true),
    // PC 活動 / Steam — default OFF。 設定 → AI / モデル の opt-out グループから ON。
    activity_app_sampling_enabled: settingBool(s, 'features.activity.app_sampling.enabled', false),
    activity_steam_enabled: settingBool(s, 'features.activity.steam.enabled', false),
  };
}

export function featureEnabled(db: Db, key: PrivacyBoolKey): boolean {
  return privacySettings(db)[key] !== false;
}
