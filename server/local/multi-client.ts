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

// ── 二層モード (Local / Multi) ───────────────────────────────────────────
//
// 旧 multi-server era は「複数 Hub を同時 active」 だったが、 二層再設計では
// データソースは排他 (= Local か、 特定 Hub 1 つ)。 app_settings に保持する:
//   multi_mode      = 'local' | 'multi'
//   multi_mode_url  = Multi モード時に向き先の Hub URL

export type MultiMode = 'local' | 'multi';

export interface ModeState {
  mode: MultiMode;
  hubUrl: string | null;
}

export function readMode(db: Db): ModeState {
  const s = getAppSettings(db);
  const mode: MultiMode = s.multi_mode === 'multi' ? 'multi' : 'local';
  const hubUrl = mode === 'multi' && s.multi_mode_url ? s.multi_mode_url.replace(/\/$/, '') : null;
  return { mode, hubUrl };
}

export function setMode(db: Db, mode: MultiMode, url?: string | null): void {
  if (mode === 'multi') {
    setAppSettings(db, {
      multi_mode: 'multi',
      multi_mode_url: String(url || '').replace(/\/$/, ''),
    });
  } else {
    setAppSettings(db, { multi_mode: 'local', multi_mode_url: '' });
  }
}

export interface HubResponse {
  status: number;
  body: unknown;
  contentType: string;
}

/**
 * Hub に直接話す (= 二層設計の proxy 経路)。 旧 multiFetch と違い Cernere を
 * 一切経由しない: Hub の `/api/auth/login` が返した session token をそのまま
 * Bearer に使う。 ステータスとボディを呼び出し側にそのまま返す (proxy のため)。
 */
export async function hubFetch(
  hubUrl: string,
  sessionToken: string,
  pathWithQuery: string,
  init: FetchInit = {},
): Promise<HubResponse> {
  const url = `${hubUrl.replace(/\/$/, '')}${pathWithQuery}`;
  const headers: Record<string, string> = {
    ...(init.headers || {}),
    'Authorization': `Bearer ${sessionToken}`,
    'X-Memoria-Origin': 'local',
  };
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return {
    status: res.status,
    body,
    contentType: res.headers.get('content-type') || 'application/json',
  };
}

/** Hub の `/api/auth/login` に email/password を渡す (Hub が Cernere に代理ログイン)。 */
export async function hubLogin(
  hubUrl: string,
  email: string,
  password: string,
): Promise<{ sessionToken: string; user: { userId: string | null; displayName: string; role: string } }> {
  const res = await fetch(`${hubUrl.replace(/\/$/, '')}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({})) as {
    sessionToken?: string;
    user?: { userId?: string | null; displayName?: string; role?: string };
    error?: string;
  };
  if (!res.ok || !data.sessionToken) {
    const err = new Error(data.error || `Hub login failed: HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status === 401 ? 401 : 502;
    throw err;
  }
  return {
    sessionToken: data.sessionToken,
    user: {
      userId: data.user?.userId ?? null,
      displayName: data.user?.displayName || '(unknown)',
      role: data.user?.role || 'general',
    },
  };
}
