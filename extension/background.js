// Memoria background service worker.
// On every tab activation/URL change, ping the local server with the current URL
// so it can record an access if that URL is bookmarked.

const DEFAULT_SERVER = 'http://localhost:5180';

// Per-URL throttle: same URL won't ping more than once every N ms across the whole browser.
const PING_THROTTLE_MS = 60 * 1000;
const lastPing = new Map();

async function getServer() {
  const { server } = await chrome.storage.sync.get({ server: DEFAULT_SERVER });
  return (server || DEFAULT_SERVER).replace(/\/+$/, '');
}

async function getAuthHeaders() {
  const { authToken } = await chrome.storage.sync.get({ authToken: '' });
  const h = { 'Content-Type': 'application/json' };
  if (authToken) h['Authorization'] = `Bearer ${authToken}`;
  return h;
}

async function isTrackingDisabled() {
  const { disableTracking } = await chrome.storage.sync.get({ disableTracking: false });
  return !!disableTracking;
}

function isPingable(url) {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

async function pingAccess(url, title) {
  if (!isPingable(url)) return;
  if (await isTrackingDisabled()) return;
  const now = Date.now();
  const prev = lastPing.get(url) ?? 0;
  if (now - prev < PING_THROTTLE_MS) return;
  lastPing.set(url, now);
  try {
    const server = await getServer();
    const headers = await getAuthHeaders();
    await fetch(`${server}/api/access`, {
      method: 'POST',
      headers,
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

// Save bookmark on behalf of the content script (bypasses page CORS).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'memoria.save') return false;
  (async () => {
    try {
      const server = await getServer();
      const headers = await getAuthHeaders();
      const res = await fetch(`${server}/api/bookmark`, {
        method: 'POST',
        headers,
        body: JSON.stringify(msg.payload || {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
      }
      const data = await res.json();
      sendResponse({ ok: true, ...data });
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
