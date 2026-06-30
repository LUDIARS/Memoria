// 「ユーザーアプリ」タブ。
//
// プラグインは Memoria 本体プロセスに in-process マウントされている
// (git submodule server/plugins/memoria-plugin)。 /api/plugins から manifest を読み、
// 登録プラグインを一覧表示する。 選択するとそのプラグイン UI を iframe で開く。
// url は同一オリジンの相対パス (/plugins/<id>) なので接続設定 (URL/トークン) は不要。
//
// 各プラグインには稼働状態 (ready / needs-setup / error) のバッジと、 単体ホットリロード
// ボタンを添える。 選択中プラグインの「傾向 (trend)」 系列があれば簡易グラフを描く。

type PluginStatus = 'ready' | 'needs-setup' | 'error';

interface PluginEntry {
  id: string;
  name: string;
  icon: string;
  description: string;
  url: string;
  status: PluginStatus;
  statusReason?: string;
}

interface PluginsResponse {
  ok: boolean;
  plugins: PluginEntry[];
  error?: string;
}

interface TrendPoint {
  plugin_id: string;
  series: string;
  value: number;
  unit: string | null;
  at: string;
}

interface TrendsResponse {
  ok: boolean;
  series: string[];
  points: TrendPoint[];
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STATUS_BADGE: Record<PluginStatus, string> = {
  ready: '',
  'needs-setup': '<span class="userapps-badge warn" title="要セットアップ">⚠ 要設定</span>',
  error: '<span class="userapps-badge err" title="初期化エラー">✖ エラー</span>',
};

function renderList(plugins: PluginEntry[]): string {
  if (!plugins.length) {
    return '<div class="muted userapps-empty">登録プラグインがありません。</div>';
  }
  return `<ul class="userapps-list">${plugins
    .map((p, i) => {
      const badge = STATUS_BADGE[p.status] ?? '';
      const reason = p.statusReason ? `<small class="userapps-reason">${esc(p.statusReason)}</small>` : '';
      return `<li>
        <button type="button" class="userapps-item${i === 0 ? ' active' : ''}" data-url="${esc(p.url)}" data-id="${esc(p.id)}">
          <span class="userapps-icon">${esc(p.icon)}</span>
          <span class="userapps-meta"><b>${esc(p.name)} ${badge}</b><small>${esc(p.description)}</small>${reason}</span>
        </button>
        <button type="button" class="userapps-reload" data-id="${esc(p.id)}" title="ホットリロード">⟳</button>
      </li>`;
    })
    .join('')}</ul>`;
}

/** trend 系列を簡易 SVG 折れ線で描く。 */
function renderTrendChart(points: TrendPoint[]): string {
  if (!points.length) return '';
  const bySeries = new Map<string, TrendPoint[]>();
  for (const p of points) {
    const arr = bySeries.get(p.series) ?? [];
    arr.push(p);
    bySeries.set(p.series, arr);
  }
  const W = 520;
  const H = 120;
  const pad = 8;
  const charts = [...bySeries.entries()]
    .map(([series, pts]) => {
      const values = pts.map((p) => p.value);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const span = max - min || 1;
      const stepX = pts.length > 1 ? (W - pad * 2) / (pts.length - 1) : 0;
      const coords = pts
        .map((p, i) => {
          const x = pad + i * stepX;
          const y = H - pad - ((p.value - min) / span) * (H - pad * 2);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
      const unit = pts[0]?.unit ? ` (${esc(pts[0].unit)})` : '';
      return `<div class="userapps-trend">
        <div class="userapps-trend-title">${esc(series)}${unit} — ${pts.length}点, ${min}〜${max}</div>
        <svg viewBox="0 0 ${W} ${H}" class="userapps-trend-svg" preserveAspectRatio="none">
          <polyline points="${coords}" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </div>`;
    })
    .join('');
  return `<div class="userapps-trends"><h4>傾向</h4>${charts}</div>`;
}

async function loadTrends(pluginId: string): Promise<void> {
  const panel = document.getElementById('userappsTrends');
  if (!panel) return;
  const res = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/trends?limit=500`).catch(() => null);
  if (!res || !res.ok) {
    panel.innerHTML = '';
    return;
  }
  const data = (await res.json()) as TrendsResponse;
  panel.innerHTML = renderTrendChart(data.points);
}

function selectPlugin(el: HTMLElement, frame: HTMLIFrameElement): void {
  const url = el.dataset.url;
  const id = el.dataset.id;
  if (!url) return;
  document.querySelectorAll('.userapps-item').forEach((o) => o.classList.remove('active'));
  el.classList.add('active');
  frame.src = url;
  if (id) void loadTrends(id);
}

function wireList(): void {
  const frame = document.getElementById('userappsFrame') as HTMLIFrameElement | null;
  if (!frame) return;
  document.querySelectorAll('.userapps-item').forEach((el) => {
    el.addEventListener('click', () => selectPlugin(el as HTMLElement, frame));
  });
  document.querySelectorAll('.userapps-reload').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const id = (el as HTMLElement).dataset.id;
      if (!id) return;
      (el as HTMLButtonElement).disabled = true;
      el.textContent = '…';
      try {
        await fetch(`/api/plugins/${encodeURIComponent(id)}/reload`, { method: 'POST' });
      } finally {
        await loadUserApps(); // manifest 再取得して再描画。
      }
    });
  });
  // 初期表示: 先頭プラグインを開く。
  const first = document.querySelector('.userapps-item') as HTMLElement | null;
  if (first) selectPlugin(first, frame);
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
        <div id="userappsTrends" class="userapps-trends-panel"></div>
      </div>
    </div>`;

  wireList();
}
