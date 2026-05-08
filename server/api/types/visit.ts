// visit (locations / page-metadata / visits) API request/response types
// Spec: spec/api/visit.md

import type { GpsLocationRow } from '../../db/types/gps.js';
import type { PageVisitRow, VisitEventSource } from '../../db/types/visit.js';
import type { PageMetadataRow } from '../../db/types/page.js';
import type { ServerEventRow } from '../../db/types/activity.js';
import type { ActivityEventRow, ActivityKind } from '../../db/types/activity.js';

export interface LocationsResponse {
  date?: string;
  from?: string;
  to?: string;
  deviceId: string | null;
  points: GpsLocationRow[];
}

export interface LocationsDaysResponse {
  days: { day: string; points: number; first_at: string; last_at: string }[];
}

export interface LocationSettingsResponse {
  has_key: boolean;
  key_preview: string;            // "abcd…wxyz" 等の masked
  source: 'env' | 'db' | 'none';
}

export interface VisitsResponse {
  items: PageVisitRow[];
}

export interface VisitsBulkUrlsRequest {
  urls: string[];
}

export interface VisitExternalIngest {
  url: string;
  domain?: string;
  title?: string;
  visited_at?: string;             // UTC ISO; default = now
  device_label?: string;
  device_os?: string;
  source?: VisitEventSource;       // 'dns' / 'sni' / 'browser'
}

export type PageMetadataResponse = PageMetadataRow;

export interface WorklogServerEventsResponse {
  items: ServerEventRow[];
}

export interface WorklogActivityResponse {
  items: ActivityEventRow[];
  total: number;
  page: { limit: number; offset: number; returned: number };
  kind?: ActivityKind | null;
}

export interface WorklogBrowsingVisit {
  url: string;
  title: string | null;
  domain: string | null;
  last_seen_at: string;
  visit_count: number;
  is_bookmarked: boolean;
  catalog: { status: string } | null;
}

export interface WorklogBrowsingResponse {
  date: string;
  visits: WorklogBrowsingVisit[];
  revisits: PageVisitRow[];
  stats: {
    top_domains: { domain: string; pages: number; visits: number }[];
  };
  enrichedTopDomains?: { domain: string; pages: number; visits: number; catalog_status: string | null }[];
}

export interface UptimeResponse {
  heartbeat: {
    server_started_at: string;
    last_heartbeat_at: string;
    pid: number;
  } | null;
  downtime_threshold_ms: number;
}
