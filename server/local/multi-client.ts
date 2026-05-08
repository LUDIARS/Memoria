// Local-side client for the multi server (Memoria Hub).
//
// State model (multi-server era):
//   app_settings.multi_servers      = JSON [{label, url, jwt?, userId?, userName?, role?, connectedAt?}]
//   app_settings.multi_active_urls  = JSON string[] (subset of urls — currently active)
//
// Backwards compatibility: if the legacy single-URL keys (multi_url + multi_jwt + …)
// are present and multi_servers is not, they are migrated on first read into a
// one-entry list with that URL active.
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db/index.js';

type Db = BetterSqlite3.Database;

const LEGACY_KEYS = {
  url: 'multi_url',
  jwt: 'multi_jwt',
  userId: 'multi_user_id',
  userName: 'multi_user_name',
  role: 'multi_role',
  connectedAt: 'multi_connected_at',
} as const;

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

export interface MultiState {
  label?: string;
  url: string | null;
  jwt: string | null;
  userId: string | null;
  userName: string | null;
  role: string | null;
  connectedAt: string | null;
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

interface FetchInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

type ConnectedState = MultiState & { url: string; jwt: string; userId: string };

type RawServer = {
  label?: unknown;
  url?: unknown;
  jwt?: unknown;
  userId?: unknown;
  userName?: unknown;
  role?: unknown;
  connectedAt?: unknown;
};

function safeJson(s: unknown, fallback: unknown): unknown {
  if (typeof s !== 'string' || !s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

function normalizeServer(s: RawServer): MultiServerEntry {
  const url = String(s.url ?? '').replace(/\/$/, '');
  const labelSrc = s.label ? String(s.label) : url;
  return {
    label:       labelSrc.slice(0, 80),
    url,
    jwt:         typeof s.jwt === 'string' ? s.jwt : null,
    userId:      typeof s.userId === 'string' ? s.userId : null,
    userName:    typeof s.userName === 'string' ? s.userName : null,
    role:        typeof s.role === 'string' ? s.role : null,
    connectedAt: typeof s.connectedAt === 'string' ? s.connectedAt : null,
  };
}

/**
 * Read all registered servers + active set. Migrates legacy single-URL keys
 * on first call.
 */
export function readMultiServers(db: Db): MultiServersList {
  const s = getAppSettings(db);
  let servers: MultiServerEntry[];
  const rawServers = safeJson(s.multi_servers, null);
  if (!Array.isArray(rawServers)) {
    // Migrate legacy single-URL state if any.
    const legacyUrl = (s[LEGACY_KEYS.url] || '').trim();
    if (legacyUrl) {
      servers = [normalizeServer({
        label: 'default',
        url: legacyUrl,
        jwt: s[LEGACY_KEYS.jwt] || null,
        userId: s[LEGACY_KEYS.userId] || null,
        userName: s[LEGACY_KEYS.userName] || null,
        role: s[LEGACY_KEYS.role] || null,
        connectedAt: s[LEGACY_KEYS.connectedAt] || null,
      })];
      setAppSettings(db, { multi_servers: JSON.stringify(servers) });
    } else {
      servers = [];
    }
  } else {
    servers = (rawServers as RawServer[]).map(normalizeServer).filter((x) => x.url);
  }
  const rawActive = safeJson(s.multi_active_urls, null);
  let active: string[];
  if (!Array.isArray(rawActive)) {
    // Default: every connected server is active. (On a fresh single-URL
    // migration that means the one entry is active.)
    active = servers.filter((x) => x.jwt && x.userId).map((x) => x.url);
    setAppSettings(db, { multi_active_urls: JSON.stringify(active) });
  } else {
    active = rawActive.filter((u): u is string => typeof u === 'string');
  }
  return { servers, active: new Set(active) };
}

export function persistServers(db: Db, servers: MultiServerEntry[], activeUrls: Set<string> | string[]): void {
  setAppSettings(db, {
    multi_servers: JSON.stringify(servers.map(normalizeServer)),
    multi_active_urls: JSON.stringify([...activeUrls]),
  });
}

export function findServerByUrl(servers: MultiServerEntry[], url: string): MultiServerEntry | null {
  const u = String(url || '').replace(/\/$/, '');
  return servers.find((s) => s.url === u) || null;
}

export function upsertServer(servers: MultiServerEntry[], patch: RawServer): MultiServerEntry[] {
  const norm = normalizeServer(patch);
  if (!norm.url) return servers;
  const i = servers.findIndex((s) => s.url === norm.url);
  const out = [...servers];
  if (i >= 0) out[i] = { ...out[i], ...norm };
  else out.push(norm);
  return out;
}

export function removeServer(servers: MultiServerEntry[], url: string): MultiServerEntry[] {
  const u = String(url || '').replace(/\/$/, '');
  return servers.filter((s) => s.url !== u);
}

/** Legacy shape — used by the share/download path; returns the FIRST active
 *  + connected server. Multi-active dispatch is handled by the caller via
 *  `forEachActive`. */
export function readMultiState(db: Db): MultiState {
  const { servers, active } = readMultiServers(db);
  for (const s of servers) {
    if (active.has(s.url) && s.jwt && s.userId) return s;
  }
  return { url: null, jwt: null, userId: null, userName: null, role: null, connectedAt: null };
}

export function isConnected(state: MultiState | null | undefined): state is ConnectedState {
  return Boolean(state && state.url && state.jwt && state.userId);
}

export function listConnectedActive(db: Db): MultiServerEntry[] {
  const { servers, active } = readMultiServers(db);
  return servers.filter((s) => active.has(s.url) && s.jwt && s.userId);
}

// ── per-server session save/load ────────────────────────────────────────

export function saveServerSession(db: Db, url: string, { jwt, userId, userName, role }: SaveSessionInput): void {
  const { servers, active } = readMultiServers(db);
  const updated = upsertServer(servers, {
    url,
    jwt,
    userId,
    userName,
    role: role || 'user',
    connectedAt: new Date().toISOString(),
    label: findServerByUrl(servers, url)?.label || url,
  });
  active.add(url.replace(/\/$/, ''));
  persistServers(db, updated, active);
}

export function clearServerSession(db: Db, url: string): void {
  const { servers, active } = readMultiServers(db);
  const u = String(url || '').replace(/\/$/, '');
  const updated = servers.map((s) => s.url === u
    ? { ...s, jwt: null, userId: null, userName: null, role: null, connectedAt: null }
    : s);
  active.delete(u);
  persistServers(db, updated, active);
}

export function setActive(db: Db, urls: string[]): void {
  const { servers } = readMultiServers(db);
  const valid = new Set(servers.map((s) => s.url));
  persistServers(db, servers, [...urls].filter((u) => valid.has(u)));
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

export async function multiFetch<T = Record<string, unknown>>(
  state: MultiState,
  path: string,
  init: FetchInit = {},
): Promise<T> {
  if (!isConnected(state)) throw new Error('not connected to a multi server');
  const url = `${state.url.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = {
    ...(init.headers || {}),
    'Authorization': `Bearer ${state.jwt}`,
    'X-Memoria-Origin': 'local',
  };
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string')
      ? (body as { error: string }).error
      : `HTTP ${res.status}`;
    const err = new Error(`multi ${path} failed: ${msg}`) as Error & { status?: number; body?: unknown };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

interface ShareBookmarkInput {
  url: string;
  title: string;
  summary?: string | null;
  memo?: string;
  categories?: string[];
}

interface ShareDigInput {
  query: string;
  status: string;
  result?: unknown;
}

interface ShareDictionaryInput {
  term: string;
  definition?: string | null;
  notes?: string | null;
}

interface ShareImplInput {
  product?: string;
  title: string;
  good_points?: string | null;
  bad_points?: string | null;
  attachment_type?: string | null;
  attachment_value?: string | null;
}

interface ShareWorkLocationInput {
  name: string;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  description?: string | null;
  url?: string | null;
  tags?: string[] | string | null;
}

export async function shareBookmark(state: MultiState, b: ShareBookmarkInput): Promise<ShareResponse> {
  return multiFetch<ShareResponse>(state, '/api/shared/bookmarks', {
    method: 'POST',
    body: JSON.stringify({
      url: b.url,
      title: b.title,
      summary: b.summary || null,
      memo: b.memo || '',
      categories: b.categories || [],
    }),
  });
}

export async function shareDig(state: MultiState, d: ShareDigInput): Promise<ShareResponse> {
  return multiFetch<ShareResponse>(state, '/api/shared/digs', {
    method: 'POST',
    body: JSON.stringify({
      query: d.query,
      status: d.status,
      result: d.result || null,
    }),
  });
}

export async function shareDictionary(state: MultiState, e: ShareDictionaryInput): Promise<ShareResponse> {
  return multiFetch<ShareResponse>(state, '/api/shared/dictionary', {
    method: 'POST',
    body: JSON.stringify({
      term: e.term,
      definition: e.definition || null,
      notes: e.notes || null,
    }),
  });
}

export async function shareImplementationNote(state: MultiState, n: ShareImplInput): Promise<ShareResponse> {
  return multiFetch<ShareResponse>(state, '/api/shared/implementation-notes', {
    method: 'POST',
    body: JSON.stringify({
      product: n.product || '',
      title: n.title,
      good_points: n.good_points || null,
      bad_points: n.bad_points || null,
      attachment_type: n.attachment_type || null,
      attachment_value: n.attachment_value || null,
    }),
  });
}

export async function shareWorkLocation(state: MultiState, w: ShareWorkLocationInput): Promise<ShareResponse> {
  return multiFetch<ShareResponse>(state, '/api/shared/work-locations', {
    method: 'POST',
    body: JSON.stringify({
      name: w.name,
      address: w.address || null,
      latitude: w.latitude == null ? null : Number(w.latitude),
      longitude: w.longitude == null ? null : Number(w.longitude),
      description: w.description || null,
      url: w.url || null,
      tags: w.tags || null,
    }),
  });
}

export async function shareWorkplacePresence(state: MultiState, presence: WorkplacePresenceInput): Promise<ShareResponse> {
  return multiFetch<ShareResponse>(state, '/api/shared/workplace-presence', {
    method: 'POST',
    body: JSON.stringify({
      workplace_name: presence.workplace_name,
      address: presence.address || null,
      latitude: presence.latitude == null ? null : Number(presence.latitude),
      longitude: presence.longitude == null ? null : Number(presence.longitude),
      kind: presence.kind === 'leave' ? 'leave' : 'enter',
    }),
  });
}

export async function fetchMe(state: MultiState): Promise<FetchMeResult> {
  return multiFetch<FetchMeResult>(state, '/api/me');
}
