// visit domain — page_visits / visit_events
// Spec: spec/data/visit.md

/** URL 単位の閲覧サマリ. */
export interface PageVisitRow {
  url: string;               // PK
  title: string | null;
  first_seen_at: string;     // UTC ISO
  last_seen_at: string;      // UTC ISO
  visit_count: number;
}

/** 個別の閲覧イベント (per-event timestamp). */
export interface VisitEventRow {
  id: number;
  url: string;
  domain: string | null;
  title: string | null;
  visited_at: string;         // UTC ISO
  device_label: string | null;
  device_os: string | null;
  source: VisitEventSource | null;
}

export type VisitEventSource = 'browser' | 'dns' | 'sni';
