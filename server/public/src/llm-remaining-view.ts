import { historyTicks, jstInputValue, parseJstInput, shiftedHistoryStart, type HistoryWindow } from './llm-history-window.js';

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
let selectedStart: number | null = null;
let displayedWindow: HistoryWindow | null = null;
const requests = new WeakMap<HTMLElement, AbortController>();

function header(loading = false): string {
  const start = selectedStart ?? displayedWindow?.from;
  const previous = displayedWindow && shiftedHistoryStart(displayedWindow, -1);
  const next = displayedWindow && shiftedHistoryStart(displayedWindow, 1);
  return `<div class="llm-remaining-head"><h3>残り使用量</h3>
    <label class="foundation-form">表示期間 <select aria-label="残量グラフの表示期間">
      ${periods.map(([value, label]) => `<option value="${value}" ${value === selectedPeriod ? 'selected' : ''}>${label}</option>`).join('')}
    </select></label><button type="button" data-refresh>残量を更新</button></div>
    <div class="llm-history-controls">
      <button type="button" data-shift="-1" aria-label="選択期間ぶん前へ" ${loading || previous == null ? 'disabled' : ''}>← 前の期間</button>
      <form class="foundation-form" data-start-form>
        <label>開始日時（日本時間） <input name="start" type="datetime-local" step="60" required
          value="${start == null ? '' : jstInputValue(start)}" max="${jstInputValue(Math.floor(Date.now() / 1000))}" ${loading ? 'disabled' : ''}></label>
        <button type="submit" ${loading ? 'disabled' : ''}>表示</button>
      </form>
      <button type="button" data-shift="1" aria-label="選択期間ぶん次へ" ${loading || next == null ? 'disabled' : ''}>次の期間 →</button>
      <button type="button" data-latest>直近へ戻る</button>
    </div>`;
}

function bindControls(panel: HTMLElement): void {
  panel.querySelector('[data-refresh]')?.addEventListener('click', () => void loadRemainingUsage(panel));
  panel.querySelector('[data-latest]')?.addEventListener('click', () => {
    selectedStart = null;
    void loadRemainingUsage(panel);
  });
  panel.querySelectorAll<HTMLButtonElement>('[data-shift]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!displayedWindow) return;
      const start = shiftedHistoryStart(displayedWindow, button.dataset.shift === '-1' ? -1 : 1);
      if (start == null) return;
      selectedStart = start;
      void loadRemainingUsage(panel);
    });
  });
  panel.querySelector<HTMLFormElement>('[data-start-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem('start') as HTMLInputElement;
    const start = parseJstInput(input.value);
    input.setCustomValidity(start == null || start < 0 || start > Date.now() / 1000 ? '現在以前の日時を指定してください' : '');
    if (!form.reportValidity() || start == null) return;
    selectedStart = start;
    void loadRemainingUsage(panel);
  });
  panel.querySelector<HTMLInputElement>('input[name="start"]')?.addEventListener('input', (event) => {
    (event.target as HTMLInputElement).setCustomValidity('');
  });
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
  const query = new URLSearchParams({ range: period });
  if (selectedStart !== null) query.set('from', String(selectedStart));
  panel.innerHTML = `${header(true)}<p class="muted">Cc の記録を読み込んでいます…</p>`;
  bindControls(panel);
  try {
    const response = await fetch(`/api/llm-usage/remaining?${query}`, {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
    });
    const body = await response.json() as HistoryWindow & { points?: Point[]; error?: string };
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    if (!Array.isArray(body.points)) throw new Error('残量データの形式が不正です');
    if (!panel.isConnected || requests.get(panel) !== request) return;
    displayedWindow = { from: body.from, to: body.to, now: body.now };
    const points = body.points;
    const providers = ['claude-code', 'codex-cli'];
    panel.innerHTML = `${header()}
      <p class="muted">${esc(date(body.from))} 〜 ${esc(date(body.to))}（${esc(periods.find(([key]) => key === period)?.[1])}）。1ヶ月は30日、3ヶ月は90日です。残り100%が未使用、0%で上限です。時刻は日本時間です。記録のない部分は空白です。</p>
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
  const ticks = historyTicks(start, end);
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
    <svg viewBox="0 0 640 174" role="img" aria-label="${esc(label)}の残量推移、${status}">
      ${[0, 50, 100].map((pct) => `<line x1="44" x2="624" y1="${20 + (100 - pct) * 1.4}" y2="${20 + (100 - pct) * 1.4}"/><text x="2" y="${24 + (100 - pct) * 1.4}">${pct}%</text>`).join('')}
      ${ticks.map((tick) => `<line x1="${44 + tick.ratio * 580}" x2="${44 + tick.ratio * 580}" y1="20" y2="160"/>`).join('')}
      <path d="${path}"/>${dots.join('')}
    </svg><div class="llm-time-axis" aria-label="時間の目盛">
      ${ticks.map((tick) => `<span class="llm-axis-tick" style="left:${tick.ratio * 100}%">${esc(tick.day)}<br>${esc(tick.time)}</span>`).join('')}
    </div>${path ? '' : '<p class="muted">この期間の記録はありません。</p>'}</div>`;
}
