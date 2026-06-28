// 「ユーザーアプリ」タブ。
//
// MemoriaPlugin (別 git 管理のサイドカー) の manifest を読み、 登録プラグインを
// 子として一覧表示する。 選択するとそのプラグイン UI を iframe で開く。
// 接続先 (ホスト URL) と announce 用トークンはここで設定する。
// プラグイン実体は Memoria リポには含めない (タブ + 接続機構 + テンプレのみ本体)。

interface PluginEntry {
  id: string;
  name: string;
  icon: string;
  description: string;
  url: string;
}

interface PluginsResponse {
  host_url: string;
  ok: boolean;
  plugins: PluginEntry[];
  error?: string;
}

interface PluginConfig {
  host_url: string;
  api_token_set: boolean;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderConfig(cfg: PluginConfig): string {
  return `
    <details class="userapps-config">
      <summary>⚙ 接続設定</summary>
      <div class="userapps-config-body">
        <label>ホスト URL
          <input id="userappsHostUrl" type="url" class="foundation-form"
                 placeholder="http://localhost:5191" value="${esc(cfg.host_url)}" />
        </label>
        <label>API トークン
          <input id="userappsToken" type="password" class="foundation-form"
                 placeholder="${cfg.api_token_set ? '(設定済 — 変更時のみ)' : '(未設定)'}" />
        </label>
        <button id="userappsSaveCfg" type="button">保存</button>
        <span id="userappsCfgStatus" class="muted"></span>
        <p class="muted" style="font-size:11px">
          プラグインからの通知 (announce) を許可するトークン。 MemoriaPlugin 側の
          <code>MEMORIA_PLUGIN_TOKEN</code> と一致させる。
        </p>
      </div>
    </details>`;
}

function renderList(plugins: PluginEntry[]): string {
  if (!plugins.length) {
    return '<div class="muted userapps-empty">登録プラグインがありません。接続設定とホストの起動を確認してください。</div>';
  }
  return `<ul class="userapps-list">${plugins
    .map(
      (p, i) =>
        `<li><button type="button" class="userapps-item${i === 0 ? ' active' : ''}" data-url="${esc(p.url)}" data-id="${esc(p.id)}">
           <span class="userapps-icon">${esc(p.icon)}</span>
           <span class="userapps-meta"><b>${esc(p.name)}</b><small>${esc(p.description)}</small></span>
         </button></li>`,
    )
    .join('')}</ul>`;
}

function wireConfig(): void {
  const btn = document.getElementById('userappsSaveCfg');
  btn?.addEventListener('click', async () => {
    const hostUrl = (document.getElementById('userappsHostUrl') as HTMLInputElement | null)?.value ?? '';
    const apiToken = (document.getElementById('userappsToken') as HTMLInputElement | null)?.value ?? '';
    const status = document.getElementById('userappsCfgStatus');
    if (status) status.textContent = '保存中…';
    const res = await fetch('/api/plugins/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host_url: hostUrl, api_token: apiToken }),
    }).catch(() => null);
    if (status) status.textContent = res && res.ok ? '保存しました。再読込します…' : '保存に失敗しました';
    if (res && res.ok) void loadUserApps();
  });
}

function wireList(): void {
  const frame = document.getElementById('userappsFrame') as HTMLIFrameElement | null;
  document.querySelectorAll('.userapps-item').forEach((el) => {
    el.addEventListener('click', () => {
      const url = (el as HTMLElement).dataset.url;
      if (!url || !frame) return;
      document.querySelectorAll('.userapps-item').forEach((o) => o.classList.remove('active'));
      el.classList.add('active');
      frame.src = url;
    });
  });
  // 初期表示: 先頭プラグインを開く。
  const first = document.querySelector('.userapps-item') as HTMLElement | null;
  if (first && frame) frame.src = first.dataset.url ?? '';
}

export async function loadUserApps(): Promise<void> {
  const root = document.getElementById('userappsRoot');
  if (!root) return;
  root.innerHTML = '<div class="muted">読み込み中…</div>';

  const [cfgRes, listRes] = await Promise.all([
    fetch('/api/plugins/config').catch(() => null),
    fetch('/api/plugins').catch(() => null),
  ]);

  const cfg: PluginConfig =
    cfgRes && cfgRes.ok ? ((await cfgRes.json()) as PluginConfig) : { host_url: '', api_token_set: false };
  const data: PluginsResponse =
    listRes && listRes.ok
      ? ((await listRes.json()) as PluginsResponse)
      : { host_url: '', ok: false, plugins: [], error: 'サーバに接続できません' };

  const errBanner = data.error
    ? `<div class="userapps-error">⚠ ${esc(data.error)}</div>`
    : '';

  root.innerHTML = `
    ${renderConfig(cfg)}
    ${errBanner}
    <div class="userapps-layout">
      <aside class="userapps-sidebar">${renderList(data.plugins)}</aside>
      <div class="userapps-content">
        <iframe id="userappsFrame" class="userapps-frame" title="ユーザーアプリ"></iframe>
      </div>
    </div>`;

  wireConfig();
  wireList();
}
