// misc (trends / recommend / events / activity / external-chat) API types
// Spec: spec/interface/misc.md

import type { ServerEventRow, ActivityEventRow, ActivityKind } from '../../db/types/activity.js';
import type { ExternalChatMessageRow } from '../../db/types/chat.js';

// ── trends ───────────────────────────────────────────────────────────────
export interface TrendCategoriesItem { category: string; count: number }
export interface TrendDomainsItem { domain: string; hits: number }
export interface TrendVisitDomainsItem { domain: string; visits: number }
export interface TrendWorkHoursItem { date: string; minutes: number | null }
export interface TrendKeywordsItem { word: string; weight: number }
export interface TrendGpsWalkingItem {
  date: string;
  distance_km: number;
  walking_minutes: number;
  travel_minutes: number;
}

export interface TrendsListResponse<T> { items: T[] }
export interface TrendsGithubResponse {
  enabled: boolean;
  items?: { date: string; commits: number; repos: { repo: string; n: number }[] }[];
  error?: string;
}

// ── recommend ────────────────────────────────────────────────────────────
export interface RecommendationItem {
  url: string;
  title: string | null;
  reason: string;
  score: number;
}

export interface RecommendationsResponse {
  items: RecommendationItem[];
}

// ── events / external-chat ───────────────────────────────────────────────
export interface EventsResponse {
  items: ServerEventRow[];
}

export interface ExternalChatListQuery {
  source?: string;
  limit?: number;
}

export interface ExternalChatListResponse {
  items: ExternalChatMessageRow[];
}

export interface ExternalChatPostRequest {
  source: string;
  conversation_id?: string;
  role?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

// ── activity ─────────────────────────────────────────────────────────────
export interface ActivityListQuery {
  date?: string;
  kind?: ActivityKind;
  limit?: number;
  offset?: number;
}

export interface ActivityListResponse {
  date?: string;
  kind?: ActivityKind | null;
  items: ActivityEventRow[];
  total: number;
  page: { limit: number; offset: number; returned: number };
}

export interface ActivityEventCreateRequest {
  kind: ActivityKind;
  occurred_at?: string;
  source?: string;
  ref_id?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface ActivityEventCreateResponse {
  id: number;
  inserted: boolean;
}
