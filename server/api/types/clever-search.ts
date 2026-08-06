// Clever Search API contracts.
// Spec: spec/interface/clever-search.md

import type { CleverSearchReport } from '../../clever-search/types.js';

export interface CleverSearchRequest {
  query: string;
  refresh?: boolean;
}

export interface CleverSearchResponse {
  reportId: number;
  cached: boolean;
  retrievalElapsedMs: number;
  report: CleverSearchReport;
}

export interface CleverSearchHistoryItem {
  id: number;
  query: string;
  totalHits: number;
  searchElapsedMs: number;
  createdAt: string;
}

export interface CleverSearchHistoryResponse {
  items: CleverSearchHistoryItem[];
}
