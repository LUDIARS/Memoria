// domain (catalog) API request/response types
// Spec: spec/interface/domain.md

import type { DomainCatalogRow } from '../../db/types/page.js';

export interface DomainListResponse {
  items: DomainCatalogRow[];
}

export interface DomainFromUrlRequest {
  url: string;                    // フル URL or "example.com"
}

export interface DomainFromUrlResponse {
  domain: string;
  queued: true;
  duplicate: boolean;
}

export interface DomainUpdateRequest {
  title?: string | null;
  site_name?: string | null;
  description?: string | null;
  can_do?: string | null;
  kind?: string | null;
  notes?: string | null;
  user_edited?: boolean;
  domain_private?: boolean;
}

export interface RecatalogAllRequest {
  force?: boolean;
}

export interface RecatalogResult {
  scanned_urls: number;
  unique_domains: number;
  queued: number;
  skipped_existing: number;
  skipped_host: number;
  queue_depth: number;
  force: boolean;
}
