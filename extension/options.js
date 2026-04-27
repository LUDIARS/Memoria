const DEFAULT_SERVER = 'http://localhost:5180';

const serverInput      = document.getElementById('server');
const trackingInput    = document.getElementById('disableTracking');
const tokenInput       = document.getElementById('authToken');
const imperativusInput = document.getElementById('imperativusUrl');
const modeLocal        = document.getElementById('modeLocal');
const modeRelay        = document.getElementById('modeRelay');
const relayFields      = document.getElementById('relayFields');
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
    mode: 'local', // 'local' | 'relay'
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
    msg.textContent = 'リレーモードでは Imperativus URL が必須です';
    msg.style.color = '#c33';
    return;
  }
  if (mode === 'relay' && !cfg.authToken) {
    msg.textContent = 'リレーモードでは Cernere service_token が必須です';
    msg.style.color = '#c33';
    return;
  }
  await chrome.storage.sync.set(cfg);
  msg.textContent = '保存しました';
  msg.style.color = '#2a7';
  setTimeout(() => { msg.textContent = ''; }, 1500);
});
