// @ts-check
// Local-side client for the multi server (Memoria Hub).
//
// State model (multi-server era):
//   app_settings.multi_servers      = JSON [{label, url, jwt?, userId?, userName?, role?, connectedAt?}]
//   app_settings.multi_active_urls  = JSON string[] (subset of urls — currently active)
//
// Backwards compatibility: if the legacy single-URL keys (multi_url + multi_jwt + …)
// are present and multi_servers is not, they are migrated on first read into a
// one-entry list with that URL active.
import { getAppSettings, setAppSettings } from '../db/index.js';

const LEGACY_KEYS = {
  url: 'multi_url',
  jwt: 'multi_jwt',
  userId: 'multi_user_id',
  userName: 'multi_user_name',
  role: 'multi_role',
  connectedAt: 'multi_connected_at',
};

function safeJson(s, fallback) {
  if (typeof s !== 'string' || !s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

function normalizeServer(s) {
  return {
    label:       (s.label || s.url || '').slice(0, 80),
    url:         String(s.url || '').replace(/\/$/, ''),
    jwt:         s.jwt || null,
    userId:      s.userId || null,
    userName:    s.userName || null,
    role:        s.role || null,
    connectedAt: s.connectedAt || null,
  };
}

/**
 * Read all registered servers + active set. Migrates legacy single-URL keys
 * on first call.
 */
export function readMultiServers(db) {
  const s = getAppSettings(db);
  let servers = safeJson(s.multi_servers, null);
  if (!Array.isArray(servers)) {
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
    servers = servers.map(normalizeServer).filter(x => x.url);
  }
  let active = safeJson(s.multi_active_urls, null);
  if (!Array.isArray(active)) {
    // Default: every connected server is active. (On a fresh single-URL
    // migration that means the one entry is active.)
    active = servers.filter(x => x.jwt && x.userId).map(x => x.url);
    setAppSettings(db, { multi_active_urls: JSON.stringify(active) });
  }
  return { servers, active: new Set(active) };
}

export function persistServers(db, servers, activeUrls) {
  setAppSettings(db, {
    multi_servers: JSON.stringify(servers.map(normalizeServer)),
    multi_active_urls: JSON.stringify([...activeUrls]),
  });
}

export function findServerByUrl(servers, url) {
  const u = String(url || '').replace(/\/$/, '');
  return servers.find(s => s.url === u) || null;
}

export function upsertServer(servers, patch) {
  const norm = normalizeServer(patch);
  if (!norm.url) return servers;
  const i = servers.findIndex(s => s.url === norm.url);
  const out = [...servers];
  if (i >= 0) out[i] = { ...out[i], ...norm };
  else out.push(norm);
  return out;
}

export function removeServer(servers, url) {
  const u = String(url || '').replace(/\/$/, '');
  return servers.filter(s => s.url !== u);
}

/** Legacy shape — used by the share/download path; returns the FIRST active
 *  + connected server. Multi-active dispatch is handled by the caller via
 *  `forEachActive`. */
export function readMultiState(db) {
  const { servers, active } = readMultiServers(db);
  for (const s of servers) {
    if (active.has(s.url) && s.jwt && s.userId) return s;
  }
  return { url: null, jwt: null, userId: null, userName: null, role: null, connectedAt: null };
}

export function isConnected(state) {
  return Boolean(state && state.url && state.jwt && state.userId);
}

export function listConnectedActive(db) {
  const { servers, active } = readMultiServers(db);
  return servers.filter(s => active.has(s.url) && s.jwt && s.userId);
}

// ── per-server session save/load ────────────────────────────────────────

export function saveServerSession(db, url, { jwt, userId, userName, role }) {
  const { servers, active } = readMultiServers(db);
  const updated = upsertServer(servers, {
    url, jwt, userId, userName, role: role || 'user',
    connectedAt: new Date().toISOString(),
    label: findServerByUrl(servers, url)?.label || url,
  });
  active.add(url.replace(/\/$/, ''));
  persistServers(db, updated, active);
}

export function clearServerSession(db, url) {
  const { servers, active } = readMultiServers(db);
  const u = String(url || '').replace(/\/$/, '');
  const updated = servers.map(s => s.url === u
    ? { ...s, jwt: null, userId: null, userName: null, role: null, connectedAt: null }
    : s);
  active.delete(u);
  persistServers(db, updated, active);
}

export function setActive(db, urls) {
  const { servers } = readMultiServers(db);
  const valid = new Set(servers.map(s => s.url));
  persistServers(db, servers, [...urls].filter(u => valid.has(u)));
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

export async function multiFetch(state, path, init = {}) {
  if (!isConnected(state)) throw new Error('not connected to a multi server');
  const url = `${state.url.replace(/\/$/, '')}${path}`;
  const headers = {
    ...(init.headers || {}),
    'Authorization': `Bearer ${state.jwt}`,
    'X-Memoria-Origin': 'local',
  };
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = (body && body.error) || `HTTP ${res.status}`;
    const err = /** @type {Error & {status?: number, body?: unknown}} */ (
      new Error(`multi ${path} failed: ${msg}`)
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function shareBookmark(state, b) {
  return multiFetch(state, '/api/shared/bookmarks', {
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

export async function shareDig(state, d) {
  return multiFetch(state, '/api/shared/digs', {
    method: 'POST',
    body: JSON.stringify({
      query: d.query,
      status: d.status,
      result: d.result || null,
    }),
  });
}

export async function shareDictionary(state, e) {
  return multiFetch(state, '/api/shared/dictionary', {
    method: 'POST',
    body: JSON.stringify({
      term: e.term,
      definition: e.definition || null,
      notes: e.notes || null,
    }),
  });
}

export async function fetchMe(state) {
  return multiFetch(state, '/api/me');
}
