// Local-side client for the multi server (Memoria Hub).
//
// Wraps the JWT plumbing — the rest of the local server just passes the
// resource shape. Connection state lives in app_settings (`multi_url`,
// `multi_jwt`, `multi_user_id`, `multi_user_name`, `multi_role`,
// `multi_connected_at`), so it survives restarts.
import { getAppSettings, setAppSettings } from '../db/index.js';

const SETTING_KEYS = {
  url: 'multi_url',
  jwt: 'multi_jwt',
  userId: 'multi_user_id',
  userName: 'multi_user_name',
  role: 'multi_role',
  connectedAt: 'multi_connected_at',
};

export function readMultiState(db) {
  const s = getAppSettings(db);
  return {
    url:         s[SETTING_KEYS.url] || null,
    jwt:         s[SETTING_KEYS.jwt] || null,
    userId:      s[SETTING_KEYS.userId] || null,
    userName:    s[SETTING_KEYS.userName] || null,
    role:        s[SETTING_KEYS.role] || null,
    connectedAt: s[SETTING_KEYS.connectedAt] || null,
  };
}

export function isConnected(state) {
  return Boolean(state.url && state.jwt && state.userId);
}

export function saveMultiUrl(db, url) {
  setAppSettings(db, { [SETTING_KEYS.url]: url });
}

export function saveMultiSession(db, { jwt, userId, userName, role }) {
  setAppSettings(db, {
    [SETTING_KEYS.jwt]: jwt,
    [SETTING_KEYS.userId]: userId,
    [SETTING_KEYS.userName]: userName,
    [SETTING_KEYS.role]: role || 'user',
    [SETTING_KEYS.connectedAt]: new Date().toISOString(),
  });
}

export function clearMultiSession(db) {
  setAppSettings(db, {
    [SETTING_KEYS.jwt]: null,
    [SETTING_KEYS.userId]: null,
    [SETTING_KEYS.userName]: null,
    [SETTING_KEYS.role]: null,
    [SETTING_KEYS.connectedAt]: null,
  });
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
    const err = new Error(`multi ${path} failed: ${msg}`);
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
