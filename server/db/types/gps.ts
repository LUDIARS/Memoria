// gps domain — gps_locations
// Spec: spec/db/gps.md

export type PlaceSource = 'places' | 'geocode' | 'cached' | 'failed';

export interface GpsLocationRow {
  id: number;
  user_id: string;            // default 'me'
  device_id: string | null;
  recorded_at: string;        // UTC ISO
  lat: number;
  lon: number;
  accuracy_m: number | null;
  altitude_m: number | null;
  velocity_kmh: number | null;
  course_deg: number | null;
  battery_pct: number | null;
  conn: string | null;
  raw_json: string | null;
  received_at: string;        // UTC ISO
  // 圧縮メタデータ (停止区間で代表点に集約された row が複数の raw を持つ)
  samples_count: number;
  samples_first_at: string | null; // UTC ISO
  // 場所解決
  place_name: string | null;
  place_address: string | null;
  place_source: PlaceSource | null;
  place_resolved_at: number | null; // unix ms
}
