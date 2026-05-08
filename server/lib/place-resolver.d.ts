// Type shims for lib/place-resolver.js (still JS, GPS reverse geocoding).

import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export interface PlaceResolveOk {
  name: string | null;
  address: string | null;
  source: 'places' | 'geocode' | 'cached';
  reused?: boolean;
}

export interface PlaceResolveFailed {
  name?: null;
  address?: null;
  source: 'failed';
  reason?: string;
}

export type PlaceResolveResult = PlaceResolveOk | PlaceResolveFailed;

export interface ResolverDebug {
  [key: string]: unknown;
}

export interface ResolveBatchOptions {
  limit?: number;
  stepMs?: number;
  onResolved?: (id: number, result: PlaceResolveResult) => void;
}

export interface ResolveBatchResult {
  processed: number;
  ok: number;
  failed: number;
}

export function getResolverDebug(): ResolverDebug;
export function resolvePlaceForRow(
  db: Db,
  row: { id: number; lat: number; lon: number },
): Promise<PlaceResolveResult>;
export function resolveUnresolvedBatch(
  db: Db,
  opts?: ResolveBatchOptions,
): Promise<ResolveBatchResult>;
