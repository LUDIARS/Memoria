// 「ユーザーアプリ」タブ。
//
// プラグインは Memoria 本体プロセスに in-process マウントされている
// (git submodule server/plugins/memoria-plugin)。 /api/plugins から manifest を読み、
// 登録プラグインを一覧表示する。 選択するとそのプラグイン UI を iframe で開く。
// url は同一オリジンの相対パス (/plugins/<id>) なので接続設定 (URL/トークン) は不要。

interface PluginEntry {
  id: string;
  name: string;
  icon: string;
  description: string;
  url: string;
}

interface PluginsResponse {
  ok: boolean;
  plugins: PluginEntry[];
  error?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderList(plugins: PluginEntry[]): string {
  if (!plugins.length) {
    return '<div class="muted userapps-empty">登録プラグインがありません。</div>';
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

  const listRes = await fetch('/api/plugins').catch(() => null);
  const data: PluginsResponse =
    listRes && listRes.ok
      ? ((await listRes.json()) as PluginsResponse)
      : { ok: false, plugins: [], error: 'サーバに接続できません' };

  const errBanner = data.error ? `<div class="userapps-error">⚠ ${esc(data.error)}</div>` : '';

  root.innerHTML = `
    ${errBanner}
    <div class="userapps-layout">
      <aside class="userapps-sidebar">${renderList(data.plugins)}</aside>
      <div class="userapps-content">
        <iframe id="userappsFrame" class="userapps-frame" title="ユーザーアプリ"></iframe>
      </div>
    </div>`;

  wireList();
}
