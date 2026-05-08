// page domain — page_metadata / domain_catalog
// Spec: spec/db/page.md

export type PageMetadataStatus = 'pending' | 'done' | 'error';

export interface PageMetadataRow {
  url: string;               // PK
  title: string | null;
  meta_description: string | null;
  og_title: string | null;
  og_description: string | null;
  og_image: string | null;
  og_type: string | null;
  content_type: string | null;
  http_status: number | null;
  summary: string | null;
  kind: string | null;
  status: PageMetadataStatus;
  error: string | null;
  fetched_at: string | null; // UTC ISO
}

export type DomainCatalogStatus = 'pending' | 'done' | 'error';

export interface DomainCatalogRow {
  domain: string;             // PK
  title: string | null;
  site_name: string | null;
  description: string | null;
  can_do: string | null;
  kind: string | null;
  notes: string | null;
  user_edited: 0 | 1;
  domain_private: 0 | 1;
  status: DomainCatalogStatus;
  error: string | null;
  fetched_at: string | null;  // UTC ISO
}
