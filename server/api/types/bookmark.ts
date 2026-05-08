// bookmark API request/response types
// Spec: spec/api/bookmark.md

import type { BookmarkRow, AccessRow } from '../../db/types/bookmark.js';

export interface BookmarkSubmitRequest {
  url: string;
  title: string;
  html: string;                  // 生 HTML 全体 (Chrome 拡張から)
}

export interface BookmarkSubmitResponse {
  id: number;
  duplicate?: true;
  queued?: true;
  queueDepth?: number;
}

export interface BookmarkFromUrlRequest {
  url: string;
}

export interface BookmarkFromUrlResponse {
  id?: number;
  title?: string;
  duplicate?: true;
  queued?: true;
  queueDepth?: number;
}

export interface BookmarkListQuery {
  category?: string;
  sort?: 'created_desc' | 'created_asc' | 'accessed_desc' | 'accessed_asc' | 'title_asc';
  q?: string;
  limit?: number;                 // default 50, max 200
  offset?: number;                // default 0
}

export interface BookmarkListResponse {
  items: BookmarkRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface BookmarkUpdateRequest {
  title?: string;
  memo?: string;
  summary?: string;
  categories?: string[];          // 全置換
}

export interface BookmarkAccessesResponse {
  items: AccessRow[];
}
