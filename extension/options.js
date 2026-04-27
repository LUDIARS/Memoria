const DEFAULT_SERVER = 'http://localhost:5180';

const serverInput = document.getElementById('server');
const trackingInput = document.getElementById('disableTracking');
const tokenInput = document.getElementById('authToken');
const msg = document.getElementById('msg');

(async () => {
  const cfg = await chrome.storage.sync.get({
    server: DEFAULT_SERVER,
    disableTracking: false,
    authToken: '',
  });
  serverInput.value = cfg.server;
  trackingInput.checked = !!cfg.disableTracking;
  tokenInput.value = cfg.authToken || '';
})();

document.getElementById('save').addEventListener('click', async () => {
  const server = serverInput.value.trim() || DEFAULT_SERVER;
  await chrome.storage.sync.set({
    server,
    disableTracking: !!trackingInput.checked,
    authToken: tokenInput.value.trim(),
  });
  msg.textContent = '保存しました';
  setTimeout(() => { msg.textContent = ''; }, 1500);
});
