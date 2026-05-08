// workplace domain — work_locations
// Spec: spec/db/workplace.md

export interface WorkLocationRow {
  id: number;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  description: string | null;
  url: string | null;
  /** カンマ区切りの自由タグ ("wifi, 電源, 静か"). */
  tags: string | null;
  shareable: 0 | 1;
  shared_at: string | null;
  shared_origin: string | null;
  // Hub からダウンロードした行のオーナー (NULL=自分)
  owner_user_id: string | null;
  owner_user_name: string | null;
  created_at: string;
  updated_at: string;
}
