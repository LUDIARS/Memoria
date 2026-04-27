const DEFAULT_SERVER = 'http://localhost:5180';

async function readConfig() {
  return chrome.storage.sync.get({
    server: DEFAULT_SERVER,
    mode: 'local',
    imperativusUrl: '',
  });
}

const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('save');
const openUi = document.getElementById('openUi');

(async () => {
  // 「Memoria を開く」 のリンクは Memoria サーバー UI を指す (relay モードでも閲覧は memoria server で).
  const cfg = await readConfig();
  openUi.href = cfg.server;
})();

saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  statusEl.className = '';
  statusEl.textContent = 'ページを取得中...';
  try {
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
    // Delegate to background — it handles local vs relay routing in one place.
    const res = await chrome.runtime.sendMessage({ type: 'memoria.save', payload: result });
    if (!res?.ok) {
      throw new Error(res?.error ?? '不明なエラー');
    }
    statusEl.className = 'ok';
    if (res.duplicate) {
      statusEl.textContent = `保存済み (id=${res.id})`;
    } else if (res.id) {
      statusEl.textContent = `保存しました (id=${res.id})。要約処理中...`;
    } else {
      statusEl.textContent = '保存しました';
    }
  } catch (e) {
    statusEl.className = 'err';
    statusEl.textContent = `エラー: ${e.message}`;
  } finally {
    saveBtn.disabled = false;
  }
});
