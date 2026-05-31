// dig (deep research + wordcloud) API request/response types
// Spec: spec/interface/dig.md

import type { DigSessionRow } from '../../db/types/dig.js';
import type { WordCloudRow, WordCloudOrigin } from '../../db/types/wordcloud.js';

export interface DigStartRequest {
  query: string;
  engine?: string;                // 'google' / 'bing' / 'duckduckgo' / 'brave' / 'default'
  theme?: string;
}

export interface DigStartResponse {
  id: number;
  status: 'pending' | 'done' | 'error';
  queueDepth: number;
}

export interface DigListResponse {
  items: DigSessionRow[];
}

export interface BulkSaveResult {
  url: string;
  status: 'queued' | 'duplicate' | 'skipped' | 'error';
  id?: number;
  error?: string;
}

export interface DigEngineOption {
  id: string;
  label: string;
}

// ── wordcloud ─────────────────────────────────────────────────────────────
export interface WordCloudGraphNode {
  id: string;
  label: string;
  shape?: 'circle' | 'square';
  weight?: number;
}

export interface WordCloudGraphEdge {
  from: string;
  to: string;
  weight?: number;
}

export interface WordCloudGraph {
  nodes: WordCloudGraphNode[];
  edges: WordCloudGraphEdge[];
  meta?: { origin: WordCloudOrigin };
}

export interface WordCloudCreateRequest {
  origin: WordCloudOrigin;
  origin_dig_id?: number;
  origin_bookmark_ids?: number[];
  parent_cloud_id?: number;
  parent_word?: string;
  label?: string;
}

export interface WordCloudListResponse {
  items: WordCloudRow[];
}

export interface WordCloudValidateRequest {
  word: string;
  context?: string;
}

export interface WordCloudValidateResponse {
  ok: boolean;
  reason?: string;
}
