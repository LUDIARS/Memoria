// Memoria background service worker.
//
// Two send modes (configured in extension options):
//
//   local : POST <memoriaServer>/api/bookmark          (no auth, single-user)
//   relay : POST <imperativusUrl>/api/relay/memoria/save_html
//                                                       (Cernere JWT, multi-user)
//
// In `relay` mode the access ping (`/api/access`) is also disabled — that
// data is local-only by design.

const DEFAULT_SERVER = 'http://localhost:5180';

const PING_THROTTLE_MS = 60 * 1000;
const lastPing = new Map();

async function readConfig() {
  return chrome.storage.sync.get({
    server: DEFAULT_SERVER,
    disableTracking: false,
    authToken: '',
    imperativusUrl: '',
    mode: 'local',
  });
}

function isPingable(url) {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

async function pingAccess(url, title) {
  if (!isPingable(url)) return;
  const cfg = await readConfig();
  // Tracking is meaningful only in local mode (single-user). The relay mode
  // is for shared deployments where we don't aggregate raw browsing data.
  if (cfg.mode !== 'local') return;
  if (cfg.disableTracking) return;
  const now = Date.now();
  const prev = lastPing.get(url) ?? 0;
  if (now - prev < PING_THROTTLE_MS) return;
  lastPing.set(url, now);
  try {
    await fetch(`${cfg.server.replace(/\/+$/, '')}/api/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title: title ?? null }),
    });
  } catch {
    // Server unreachable — silently ignore. We'll retry on next activation.
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) pingAccess(tab.url, tab.title);
  } catch {}
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active && tab.url) {
    pingAccess(tab.url, tab.title);
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.url) pingAccess(tab.url, tab.title);
  } catch {}
});

/**
 * Save bookmark on behalf of popup / content script.
 * Routes either to Memoria HTTP directly (local) or to Imperativus relay.
 */
async function saveBookmark(payload) {
  const cfg = await readConfig();
  if (cfg.mode === 'relay') {
    if (!cfg.imperativusUrl) throw new Error('Imperativus URL が設定されていません (オプションを開く)');
    if (!cfg.authToken)      throw new Error('Cernere service_token が設定されていません');
    const url = `${cfg.imperativusUrl.replace(/\/+$/, '')}/api/relay/memoria/save_html`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.authToken}`,
      },
      body: JSON.stringify({ url: payload.url, title: payload.title, html: payload.html }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Imperativus ${res.status} ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    // peer-relay-api wraps the peer result; extract the inner shape.
    return { ok: true, ...(data.result || data) };
  }

  // local mode: direct POST (no auth)
  const url = `${cfg.server.replace(/\/+$/, '')}/api/bookmark`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Memoria ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return { ok: true, ...data };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'memoria.save') return false;
  (async () => {
    try {
      const result = await saveBookmark(msg.payload || {});
      sendResponse(result);
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async response
});

// Periodic light-touch ping for the currently active tab so a long-lived view
// still produces an access entry over time.
chrome.alarms?.create('memoria-active-ping', { periodInMinutes: 5 });
chrome.alarms?.onAlarm.addListener(async (a) => {
  if (a.name !== 'memoria-active-ping') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.url) pingAccess(tab.url, tab.title);
  } catch {}
});
