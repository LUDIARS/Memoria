// Type shims for local/multi-client.js (still JS, kept per migration plan).
// Spec: server/lib internal — Hub 連携クライアント。

import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export interface MultiServerEntry {
  label: string;
  url: string;
  jwt: string | null;
  userId: string | null;
  userName: string | null;
  role: string | null;
  connectedAt: string | null;
}

export interface MultiServersList {
  servers: MultiServerEntry[];
  active: Set<string>;
}

export interface MultiState extends MultiServerEntry {
  /** 現在 active かつ jwt があるサーバの primary。 1 つも繋がっていなければ url='' */
  url: string;
}

export interface MultiServerPatch {
  url: string;
  label?: string;
}

export interface SaveSessionInput {
  jwt: string;
  userId: string | null;
  userName: string | null;
  role: string | null;
}

export interface FetchMeResult {
  userId: string;
  displayName: string;
  role: string | null;
}

export interface ShareResponse {
  id: number;
  shared_at: string;
  occurred_at?: string;
  [key: string]: unknown;
}

export interface WorkplacePresenceInput {
  workplace_name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  kind: 'enter' | 'leave';
}

export function readMultiServers(db: Db): MultiServersList;
export function persistServers(db: Db, servers: MultiServerEntry[], activeUrls: Set<string>): void;
export function findServerByUrl(servers: MultiServerEntry[], url: string): MultiServerEntry | undefined;
export function upsertServer(servers: MultiServerEntry[], patch: MultiServerPatch): MultiServerEntry[];
export function removeServer(servers: MultiServerEntry[], url: string): MultiServerEntry[];
export function readMultiState(db: Db): MultiState;
export function isConnected(state: MultiState): boolean;
export function listConnectedActive(db: Db): MultiServerEntry[];
export function saveServerSession(db: Db, url: string, input: SaveSessionInput): void;
export function clearServerSession(db: Db, url: string): void;
export function setActive(db: Db, urls: string[]): void;
export function multiFetch<T = Record<string, unknown>>(
  state: MultiState,
  path: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
): Promise<T>;
export function fetchMe(state: MultiState): Promise<FetchMeResult>;
export function shareBookmark(state: MultiState, b: unknown): Promise<ShareResponse>;
export function shareDig(state: MultiState, d: unknown): Promise<ShareResponse>;
export function shareDictionary(state: MultiState, e: unknown): Promise<ShareResponse>;
export function shareImplementationNote(state: MultiState, n: unknown): Promise<ShareResponse>;
export function shareWorkLocation(state: MultiState, w: unknown): Promise<ShareResponse>;
export function shareWorkplacePresence(state: MultiState, presence: WorkplacePresenceInput): Promise<ShareResponse>;
