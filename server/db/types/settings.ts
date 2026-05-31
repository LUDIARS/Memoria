// app_settings domain
// Spec: spec/data/settings.md

/** key/value 永続化テーブル. キーは namespace.subkey 形式 (例: features.tracks.enabled). */
export interface AppSettingRow {
  key: string;                 // PK
  value: string | null;
}
