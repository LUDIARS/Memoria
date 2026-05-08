const DEFAULT_SERVER = 'http://localhost:5180';

const serverInput = document.getElementById('server');
const msg = document.getElementById('msg');
const chatRows = document.getElementById('chatRows');
const implRows = document.getElementById('implRows');
const shoppingRows = document.getElementById('shoppingRows');
const notionRows = document.getElementById('notionRows');

let rules = { chat_domains: [], impl_rules: [], shopping_domains: [], notion_domains: [] };

async function getServer() {
  const { server } = await chrome.storage.sync.get({ server: DEFAULT_SERVER });
  return (server || DEFAULT_SERVER).replace(/\/+$/, '');
}

async function fetchRules() {
  const server = await getServer();
  const res = await fetch(`${server}/api/extension/rules`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function pushRules(next) {
  const server = await getServer();
  const res = await fetch(`${server}/api/extension/rules`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(next),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function escapeAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;');
}

function renderChat() {
  chatRows.innerHTML = rules.chat_domains.map((d, i) => `
    <tr data-i="${i}">
      <td><input type="text" data-k="host" value="${escapeAttr(d.host)}" /></td>
      <td>
        <select data-k="source">
          <option value="chatgpt"${d.source === 'chatgpt' ? ' selected' : ''}>chatgpt</option>
          <option value="claude"${d.source === 'claude' ? ' selected' : ''}>claude</option>
          <option value="gemini"${d.source === 'gemini' ? ' selected' : ''}>gemini</option>
        </select>
      </td>
      <td><input type="checkbox" data-k="enabled"${d.enabled ? ' checked' : ''} /></td>
      <td><button class="danger" data-act="del-chat">削除</button></td>
    </tr>
  `).join('');
  bindRowEvents(chatRows, rules.chat_domains);
}

function renderImpl() {
  implRows.innerHTML = rules.impl_rules.map((r, i) => `
    <tr data-i="${i}">
      <td><input type="text" data-k="label" value="${escapeAttr(r.label)}" /></td>
      <td><input type="text" data-k="host_pattern" value="${escapeAttr(r.host_pattern)}" /></td>
      <td><input type="text" data-k="keywords" value="${escapeAttr((r.keywords || []).join(', '))}" /></td>
      <td><input type="checkbox" data-k="enabled"${r.enabled ? ' checked' : ''} /></td>
      <td><button class="danger" data-act="del-impl">削除</button></td>
    </tr>
  `).join('');
  bindRowEvents(implRows, rules.impl_rules, { keywords: (s) => s.split(',').map((x) => x.trim()).filter(Boolean) });
}

function renderShopping() {
  shoppingRows.innerHTML = rules.shopping_domains.map((d, i) => `
    <tr data-i="${i}">
      <td><input type="text" data-k="host" value="${escapeAttr(d.host)}" /></td>
      <td><input type="text" data-k="label" value="${escapeAttr(d.label)}" /></td>
      <td><input type="checkbox" data-k="enabled"${d.enabled ? ' checked' : ''} /></td>
      <td><button class="danger" data-act="del-shopping">削除</button></td>
    </tr>
  `).join('');
  bindRowEvents(shoppingRows, rules.shopping_domains);
}

function renderNotion() {
  if (!notionRows) return;
  notionRows.innerHTML = (rules.notion_domains || []).map((d, i) => `
    <tr data-i="${i}">
      <td><input type="text" data-k="host" value="${escapeAttr(d.host)}" /></td>
      <td><input type="checkbox" data-k="enabled"${d.enabled ? ' checked' : ''} /></td>
      <td><button class="danger" data-act="del-notion">削除</button></td>
    </tr>
  `).join('');
  bindRowEvents(notionRows, rules.notion_domains);
}

function bindRowEvents(container, list, transformers = {}) {
  container.querySelectorAll('tr').forEach((tr) => {
    const i = Number(tr.dataset.i);
    tr.querySelectorAll('input, select').forEach((el) => {
      const k = el.dataset.k;
      if (!k) return;
      const event = el.type === 'checkbox' ? 'change' : 'input';
      el.addEventListener(event, () => {
        let v = el.type === 'checkbox' ? el.checked : el.value;
        if (transformers[k]) v = transformers[k](v);
        list[i][k] = v;
      });
    });
    tr.querySelectorAll('button[data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        list.splice(i, 1);
        renderAll();
      });
    });
  });
}

function renderAll() { renderChat(); renderImpl(); renderShopping(); renderNotion(); }

document.getElementById('addChat').addEventListener('click', () => {
  rules.chat_domains.push({ host: '', source: 'chatgpt', enabled: true });
  renderChat();
});
document.getElementById('addImpl').addEventListener('click', () => {
  rules.impl_rules.push({ label: '', host_pattern: '', keywords: [], enabled: true });
  renderImpl();
});
document.getElementById('addShopping').addEventListener('click', () => {
  rules.shopping_domains.push({ host: '', label: '', enabled: true });
  renderShopping();
});
document.getElementById('addNotion')?.addEventListener('click', () => {
  if (!Array.isArray(rules.notion_domains)) rules.notion_domains = [];
  rules.notion_domains.push({ host: '', enabled: true });
  renderNotion();
});

document.getElementById('save').addEventListener('click', async () => {
  msg.textContent = '保存中...';
  msg.style.color = '#666';
  try {
    const server = serverInput.value.trim() || DEFAULT_SERVER;
    await chrome.storage.sync.set({ server });
    await pushRules(rules);
    msg.textContent = '保存しました';
    msg.style.color = '#2a7';
    setTimeout(() => { msg.textContent = ''; }, 1800);
  } catch (e) {
    msg.textContent = `エラー: ${e.message}`;
    msg.style.color = '#c33';
  }
});

(async () => {
  const { server } = await chrome.storage.sync.get({ server: DEFAULT_SERVER });
  serverInput.value = server;
  try {
    rules = await fetchRules();
    renderAll();
  } catch (e) {
    msg.textContent = `ルール取得失敗: ${e.message}`;
    msg.style.color = '#c33';
  }
})();
