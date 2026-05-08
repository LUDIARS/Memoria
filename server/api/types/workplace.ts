// workplace API request/response types
// Spec: spec/api/workplace.md

import type { WorkLocationRow } from '../../db/types/workplace.js';

export interface WorkLocationListResponse {
  items: WorkLocationRow[];
}

export interface WorkLocationCreateRequest {
  name: string;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  description?: string | null;
  url?: string | null;
  tags?: string | null;          // カンマ区切り
  shareable?: boolean;
}

export interface WorkLocationUpdateRequest {
  name?: string;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  description?: string | null;
  url?: string | null;
  tags?: string | null;
  shareable?: boolean;
}

export interface WorkLocationMutationResponse {
  location: WorkLocationRow;
}

// Place API (Nominatim 等) からの逆ジオコーディング結果
export interface ResolvePlaceRequest {
  latitude: number;
  longitude: number;
}

export interface ResolvePlaceResponse {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  raw?: { osm_id?: number | string; type?: string; category?: string };
}

// 自動チェックイン
export interface CheckinRequest {
  latitude: number;
  longitude: number;
}

export interface CheckinResponse {
  matched: boolean;
  workplace: WorkLocationRow | null;
  distance_m: number | null;
  changed: boolean;
  /** opt-in した場合の Hub broadcast 結果。 */
  broadcast: { ok: true; id: number; occurred_at: string } | { ok: false; error: string } | { ok: true; kind: 'leave' } | null;
}

// 1 日分の作業セッション (GPS + workplace + activity_events)
export interface WorkSession {
  workplace_id: number;
  workplace_name: string;
  workplace_address: string;
  started_at: string;             // UTC ISO
  ended_at: string;               // UTC ISO (= 50m+ になった瞬間 / 別 workplace に切り替わった瞬間)
  duration_min: number;
  points_count: number;
  is_home: boolean;
  is_working: boolean;
  activity_counts: Record<string, number>;
}

export interface WorkSessionsResponse {
  date: string;                   // 'YYYY-MM-DD'
  items: WorkSession[];           // ≥60 分のみ
  tallies: {
    home_minutes: number;
    workplace_minutes: number;
    by_workplace: Record<string, number>;
  };
}
