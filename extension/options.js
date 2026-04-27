const DEFAULT_SERVER = 'http://localhost:5180';

const serverInput = document.getElementById('server');
const msg = document.getElementById('msg');

(async () => {
  const { server } = await chrome.storage.sync.get({ server: DEFAULT_SERVER });
  serverInput.value = server;
})();

document.getElementById('save').addEventListener('click', async () => {
  const server = serverInput.value.trim() || DEFAULT_SERVER;
  await chrome.storage.sync.set({ server });
  msg.textContent = '保存しました';
  setTimeout(() => { msg.textContent = ''; }, 1500);
});
