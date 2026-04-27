const DEFAULT_SERVER = 'http://localhost:5180';

const serverInput      = document.getElementById('server');
const trackingInput    = document.getElementById('disableTracking');
const tokenInput       = document.getElementById('authToken');
const imperativusInput = document.getElementById('imperativusUrl');
const modeLocal        = document.getElementById('modeLocal');
const modeRelay        = document.getElementById('modeRelay');
const relayFields      = document.getElementById('relayFields');
const ssoBtn           = document.getElementById('ssoBtn');
const ssoStatus        = document.getElementById('ssoStatus');
const msg              = document.getElementById('msg');

function applyModeToggle() {
  relayFields.style.display = modeRelay.checked ? 'block' : 'none';
}

(async () => {
  const cfg = await chrome.storage.sync.get({
    server: DEFAULT_SERVER,
    disableTracking: false,
    authToken: '',
    imperativusUrl: '',
    mode: 'local',
  });
  serverInput.value      = cfg.server;
  trackingInput.checked  = !!cfg.disableTracking;
  tokenInput.value       = cfg.authToken || '';
  imperativusInput.value = cfg.imperativusUrl || '';
  if (cfg.mode === 'relay') modeRelay.checked = true; else modeLocal.checked = true;
  applyModeToggle();
})();

modeLocal.addEventListener('change', applyModeToggle);
modeRelay.addEventListener('change', applyModeToggle);

document.getElementById('save').addEventListener('click', async () => {
  const mode = modeRelay.checked ? 'relay' : 'local';
  const cfg = {
    server: (serverInput.value.trim() || DEFAULT_SERVER).replace(/\/+$/, ''),
    disableTracking: !!trackingInput.checked,
    authToken: tokenInput.value.trim(),
    imperativusUrl: (imperativusInput.value.trim() || '').replace(/\/+$/, ''),
    mode,
  };
  if (mode === 'relay' && !cfg.imperativusUrl) {
    showMsg('リレーモードでは Imperativus URL が必須です', 'err');
    return;
  }
  if (mode === 'relay' && !cfg.authToken) {
    showMsg('リレーモードでは Cernere service_token が必須です', 'err');
    return;
  }
  await chrome.storage.sync.set(cfg);
  showMsg('保存しました', 'ok');
});

ssoBtn?.addEventListener('click', async () => {
  ssoStatus.textContent = 'Cernere ベース URL を取得中...';
  ssoStatus.style.color = '#555';
  try {
    const cernereBase = await discoverCernereBase();
    if (!cernereBase) throw new Error('Cernere base URL を取得できません (Memoria の env CERNERE_BASE_URL 設定を確認)');

    const redirectUri = chrome.identity.getRedirectURL('cernere-cb');
    const url =
      `${cernereBase.replace(/\/+$/, '')}/api/auth/extension?service=memoria` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${Math.random().toString(36).slice(2)}`;

    ssoStatus.textContent = 'Cernere のポップアップでサインイン...';
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, async (responseUrl) => {
      if (chrome.runtime.lastError) {
        ssoStatus.textContent = `失敗: ${chrome.runtime.lastError.message}`;
        ssoStatus.style.color = '#c33';
        return;
      }
      try {
        const u = new URL(responseUrl);
        const params = new URLSearchParams(u.hash.replace(/^#/, '') || u.search);
        const token = params.get('token') || params.get('access_token') || params.get('service_token');
        if (!token) throw new Error('redirect URL に token がありません');
        await chrome.storage.sync.set({ authToken: token });
        tokenInput.value = token;
        ssoStatus.textContent = 'サインイン成功 (token 保存済み)';
        ssoStatus.style.color = '#2a7';
      } catch (e) {
        ssoStatus.textContent = `redirect 解析失敗: ${e.message}`;
        ssoStatus.style.color = '#c33';
      }
    });
  } catch (e) {
    ssoStatus.textContent = `失敗: ${e.message}`;
    ssoStatus.style.color = '#c33';
  }
});

async function discoverCernereBase() {
  const cfg = await chrome.storage.sync.get({ server: DEFAULT_SERVER });
  try {
    const r = await fetch(`${cfg.server.replace(/\/+$/, '')}/api/mode`).then((x) => x.json());
    return r?.hints?.cernere_base_url || '';
  } catch {
    return '';
  }
}

function showMsg(text, kind) {
  msg.textContent = text;
  msg.style.color = kind === 'ok' ? '#2a7' : '#c33';
  if (kind === 'ok') setTimeout(() => { msg.textContent = ''; }, 1500);
}
