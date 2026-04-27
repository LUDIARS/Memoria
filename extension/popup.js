const DEFAULT_SERVER = 'http://localhost:5180';

async function getServer() {
  const { server } = await chrome.storage.sync.get({ server: DEFAULT_SERVER });
  return server.replace(/\/+$/, '');
}

const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('save');
const openUi = document.getElementById('openUi');

(async () => {
  openUi.href = await getServer();
})();

saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  statusEl.className = '';
  statusEl.textContent = 'ページを取得中...';
  try {
    const server = await getServer();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('アクティブなタブが見つかりません');
    if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://')) {
      throw new Error('このページは保存できません');
    }
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        html: document.documentElement.outerHTML,
        title: document.title,
        url: location.href,
      }),
    });
    statusEl.textContent = '送信中...';
    const res = await fetch(`${server}/api/bookmark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`サーバーエラー ${res.status}: ${text.slice(0, 100)}`);
    }
    const data = await res.json();
    statusEl.className = 'ok';
    statusEl.textContent = `保存しました (id=${data.id})。要約処理中...`;
  } catch (e) {
    statusEl.className = 'err';
    statusEl.textContent = `エラー: ${e.message}`;
  } finally {
    saveBtn.disabled = false;
  }
});
