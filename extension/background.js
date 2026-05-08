// Memoria background service worker.
//
// 役割:
//   1. tab activation / url 変更で /api/access ping (既存)
//   2. content script からの保存 / dispatch リクエストを処理
//   3. 拡張ルール (/api/extension/rules) を 5 分キャッシュして配布

const DEFAULT_SERVER = 'http://localhost:5180';

// Per-URL throttle
const PING_THROTTLE_MS = 60 * 1000;
const lastPing = new Map();

// Rules cache
const RULES_CACHE_MS = 5 * 60 * 1000;
let rulesCache = null;
let rulesCacheAt = 0;

async function getServer() {
  const { server } = await chrome.storage.sync.get({ server: DEFAULT_SERVER });
  return (server || DEFAULT_SERVER).replace(/\/+$/, '');
}

function isPingable(url) {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

async function pingAccess(url, title) {
  if (!isPingable(url)) return;
  const now = Date.now();
  const prev = lastPing.get(url) ?? 0;
  if (now - prev < PING_THROTTLE_MS) return;
  lastPing.set(url, now);
  try {
    const server = await getServer();
    await fetch(`${server}/api/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title: title ?? null }),
    });
  } catch { /* server unreachable, retry later */ }
}

async function getExtensionRules() {
  const now = Date.now();
  if (rulesCache && now - rulesCacheAt < RULES_CACHE_MS) return rulesCache;
  try {
    const server = await getServer();
    const res = await fetch(`${server}/api/extension/rules`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rulesCache = await res.json();
    rulesCacheAt = now;
  } catch (e) {
    if (!rulesCache) {
      // sane fallback if server is down
      rulesCache = {
        chat_domains: [
          { host: 'chatgpt.com', source: 'chatgpt', enabled: true },
          { host: 'chat.openai.com', source: 'chatgpt', enabled: true },
          { host: 'claude.ai', source: 'claude', enabled: true },
          { host: 'gemini.google.com', source: 'gemini', enabled: true },
        ],
        impl_rules: [],
        shopping_domains: [
          { host: 'amazon.co.jp', label: 'Amazon (JP)', enabled: true },
          { host: 'amazon.com', label: 'Amazon (US)', enabled: true },
        ],
      };
    }
  }
  return rulesCache;
}

function hostMatches(host, pattern) {
  if (!pattern) return false;
  const cleaned = pattern.replace(/^https?:\/\//, '').replace(/\/.*/, '');
  return host === cleaned || host.endsWith('.' + cleaned);
}

function detectDispatch({ url, host, title, bodyText }) {
  return getExtensionRules().then((rules) => {
    const dispatches = [];
    // chat
    for (const d of rules.chat_domains || []) {
      if (!d.enabled) continue;
      if (hostMatches(host, d.host)) {
        dispatches.push({ kind: 'chat', source: d.source, host: d.host });
      }
    }
    // impl
    for (const r of rules.impl_rules || []) {
      if (!r.enabled) continue;
      if (!hostMatches(host, r.host_pattern.split('/')[0])) continue;
      const haystack = `${url} ${title} ${bodyText}`.toLowerCase();
      const hit = (r.keywords || []).some((kw) => kw && haystack.includes(String(kw).toLowerCase()));
      if (hit) dispatches.push({ kind: 'impl', label: r.label, host: host });
    }
    // shopping
    for (const d of rules.shopping_domains || []) {
      if (!d.enabled) continue;
      if (hostMatches(host, d.host)) {
        dispatches.push({ kind: 'shopping', host: d.host, label: d.label });
      }
    }
    return { dispatches };
  });
}

// ── Tab listeners (existing access ping) ──────────────────────────────────

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

// ── Message router ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'memoria.detectDispatch') {
    detectDispatch({
      url: msg.url || '',
      host: msg.host || '',
      title: msg.title || '',
      bodyText: msg.bodyText || '',
    }).then(sendResponse).catch((e) => sendResponse({ error: e.message, dispatches: [] }));
    return true;
  }

  if (msg.type === 'memoria.save') {
    handleSave(msg.payload || {}).then(sendResponse);
    return true;
  }

  if (msg.type === 'memoria.saveChat') {
    handleSaveChat(msg.payload || {}).then(sendResponse);
    return true;
  }

  if (msg.type === 'memoria.expandImpl') {
    handleExpandImpl(msg.payload || {}).then(sendResponse);
    return true;
  }

  if (msg.type === 'memoria.addWishlist') {
    handleAddWishlist(msg.payload || {}).then(sendResponse);
    return true;
  }

  return false;
});

async function handleSave(payload) {
  try {
    const server = await getServer();
    const res = await fetch(`${server}/api/bookmark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
    }
    const data = await res.json();
    return { ok: true, ...data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleSaveChat(payload) {
  try {
    const server = await getServer();
    const res = await fetch(`${server}/api/notes/from-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
    }
    const data = await res.json();
    return { ok: true, ...data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleExpandImpl(payload) {
  try {
    const server = await getServer();
    const res = await fetch(`${server}/api/implementation-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product: payload.host || '',
        title: payload.title || 'Untitled',
        good_points: '',
        bad_points: '',
        attachment_type: payload.host && payload.host.includes('github.com') ? 'github' : 'article',
        attachment_value: payload.url || '',
        shareable: false,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
    }
    const data = await res.json();
    return { ok: true, ...data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleAddWishlist(payload) {
  try {
    const server = await getServer();
    // 「買い物」 カテゴリを未登録なら register
    try {
      await fetch(`${server}/api/tasks/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '買い物' }),
      });
    } catch { /* ignore */ }

    const res = await fetch(`${server}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: (payload.title || '').slice(0, 200) || 'ほしいもの',
        details: payload.url || '',
        status: 'todo',
        creator_type: 'human',
        category: '買い物',
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
    }
    const data = await res.json();
    return { ok: true, ...data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Periodic light-touch ping for the currently active tab (existing).
chrome.alarms?.create('memoria-active-ping', { periodInMinutes: 5 });
chrome.alarms?.onAlarm.addListener(async (a) => {
  if (a.name !== 'memoria-active-ping') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.url) pingAccess(tab.url, tab.title);
  } catch {}
});
