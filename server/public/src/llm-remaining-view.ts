interface Point {
  ts: number;
  provider: string;
  plan: string | null;
  used5hPct: number | null;
  usedWeeklyPct: number | null;
  reset5hAt: number | null;
  resetWeeklyAt: number | null;
}

const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g,
  (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char);
const date = (ts: number): string => new Date(ts * 1000).toLocaleString('ja-JP', {
  timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
const remaining = (used: number): number => Math.max(0, Math.min(100, 100 - used));
const periods = [ ['3m', '3ヶ月'], ['1m', '1ヶ月'], ['1w', '1週間'], ['1d', '1日'], ['1h', '1時間'] ] as const;
type Period = typeof periods[number][0];
let selectedPeriod: Period = '1w';
const requests = new WeakMap<HTMLElement, AbortController>();

function header(): string {
  return `<div class="llm-remaining-head"><h3>残り使用量</h3>
    <label class="foundation-form">表示期間 <select aria-label="残量グラフの表示期間">
      ${periods.map(([value, label]) => `<option value="${value}" ${value === selectedPeriod ? 'selected' : ''}>${label}</option>`).join('')}
    </select></label><button type="button">残量を更新</button></div>`;
}

function bindControls(panel: HTMLElement): void {
  panel.querySelector('button')?.addEventListener('click', () => void loadRemainingUsage(panel));
  panel.querySelector('select')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value;
    const period = periods.find(([key]) => key === value);
    if (!period) return;
    selectedPeriod = period[0];
    void loadRemainingUsage(panel);
  });
}

/** Each render owns one request and button; disconnected panels never receive results. */
export async function loadRemainingUsage(panel: HTMLElement): Promise<void> {
  requests.get(panel)?.abort();
  const request = new AbortController();
  requests.set(panel, request);
  const period = selectedPeriod;
  panel.innerHTML = `${header()}<p class="muted">Cc の記録を読み込んでいます…</p>`;
  bindControls(panel);
  try {
    const response = await fetch(`/api/llm-usage/remaining?range=${period}`, {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
    });
    const body = await response.json() as { points?: Point[]; from: number; to: number; error?: string };
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    if (!Array.isArray(body.points)) throw new Error('残量データの形式が不正です');
    if (!panel.isConnected || requests.get(panel) !== request) return;
    const points = body.points;
    const providers = ['claude-code', 'codex-cli'];
    panel.innerHTML = `${header()}
      <p class="muted">Cc と同じ記録・直近${esc(periods.find(([key]) => key === period)?.[1])}。1ヶ月は30日、3ヶ月は90日です。残り100%が未使用、0%で上限です。時刻は日本時間です。</p>
      <div class="llm-remaining-grid">${providers.map((provider) => {
        const rows = points.filter((row) => row.provider === provider).sort((a, b) => a.ts - b.ts);
        const name = provider === 'claude-code' ? 'Claude' : 'Codex';
        const latest = rows[rows.length - 1];
        return `<article><h4>${name}${latest?.plan ? ` (${esc(latest.plan)})` : ''}</h4>
          ${chart(rows, 'usedWeeklyPct', 'resetWeeklyAt', `${name} 週間枠`, body.from, body.to)}
          ${chart(rows, 'used5hPct', 'reset5hAt', `${name} 短時間枠（日別 / 5時間）`, body.from, body.to)}</article>`;
      }).join('')}</div>`;
  } catch (error: unknown) {
    if (!panel.isConnected || requests.get(panel) !== request) return;
    panel.innerHTML = `${header()}
      <p role="status">残量を表示できません: ${esc(error instanceof Error ? error.message : '読込失敗')}</p>`;
  }
  bindControls(panel);
}

function chart(rows: Point[], field: 'usedWeeklyPct' | 'used5hPct', resetField: 'resetWeeklyAt' | 'reset5hAt', label: string, start: number, end: number): string {
  const latest = rows[rows.length - 1];
  const value = latest?.[field];
  const status = value == null ? '未取得' : `残り ${remaining(value).toFixed(1)}%`;
  const reset = latest?.[resetField];
  const observed = latest ? `観測 ${date(latest.ts)}` : '記録なし';
  const x = (ts: number): number => 44 + (ts - start) / Math.max(1, end - start) * 580;
  const y = (used: number): number => 20 + (100 - remaining(used)) * 1.4;
  // Missing observations break the line instead of manufacturing a carried-forward limit.
  let connected = false;
  let path = '';
  const dots: string[] = [];
  for (const row of rows) {
    const used = row[field];
    if (used == null) { connected = false; continue; }
    const px = x(row.ts).toFixed(2), py = y(used).toFixed(2);
    path += `${connected ? 'L' : 'M'}${px},${py} `;
    connected = true;
    // Long ranges retain every observation in one path without creating thousands of DOM nodes.
    if (rows.length <= 120) dots.push(`<circle cx="${px}" cy="${py}" r="2"><title>${esc(date(row.ts))}: 残り ${remaining(used).toFixed(1)}%</title></circle>`);
  }
  return `<div class="llm-remaining-chart"><strong>${esc(label)} — ${status}</strong>
    <small class="muted">${esc(observed)}${reset == null || value == null ? '' : ` / リセット予定 ${esc(date(reset))}`}</small>
    ${path ? `<svg viewBox="0 0 640 194" role="img" aria-label="${esc(label)}の残量推移、${status}">
      ${[0, 50, 100].map((pct) => `<line x1="44" x2="624" y1="${20 + (100 - pct) * 1.4}" y2="${20 + (100 - pct) * 1.4}"/><text x="2" y="${24 + (100 - pct) * 1.4}">${pct}%</text>`).join('')}
      <path d="${path}"/>${dots.join('')}
      <text x="44" y="186">${esc(date(start))}</text><text x="624" y="186" text-anchor="end">${esc(date(end))}</text>
    </svg>` : '<p class="muted">この枠の残量はまだ取得されていません。</p>'}</div>`;
}
