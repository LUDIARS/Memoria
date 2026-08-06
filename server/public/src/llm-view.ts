interface Metric { value: number | null; delta: number | null }
interface InventoryRow {
  date: string;
  captured_at: string;
  skills: Metric;
  memories: Metric;
  genius_cards: Metric;
  judgment_logs: Metric;
  local_llms: Array<{ configuredModel: string; available: boolean; models: Array<{ id: string }> }>;
  source_errors: string[];
}
interface UsageSummary {
  sessions: number;
  contexts: number;
  total_tokens: number;
  cost_usd: number;
  cache_hit_rate: number | null;
  date_from?: string | null;
  date_to?: string | null;
}
interface SessionRow extends UsageSummary {
  provider: string;
  session_id: string;
  started_at: string | null;
  ended_at: string | null;
  repo_name: string | null;
  models: string;
  efforts: string;
  cost_basis: string;
}
interface DailyRow extends UsageSummary { date: string }
interface WeeklyRow { week: string; cost_usd: number; tokens: number; sessions: number; contexts: number }
interface Dashboard {
  today: UsageSummary;
  total: UsageSummary;
  daily: DailyRow[];
  weekly: WeeklyRow[];
  sessions: SessionRow[];
  inventory: InventoryRow[];
  sources: { total: number; failed: number; last_imported_at: string | null };
  methodology: { reference: string; initial_import_days: number };
  sync: { state: string; progress: { current: number; total: number }; error: string | null };
}

let pollTimer: number | null = null;

export async function loadLlmView(): Promise<void> {
  const root = document.getElementById('llmRoot');
  if (!root) return;
  root.innerHTML = '<div class="empty">LLM 利用ログを読み込んでいます…</div>';
  try {
    const dashboard = await getJson<Dashboard>('/api/llm-usage');
    render(root, dashboard);
    if (dashboard.sources.total === 0 && dashboard.sync.state !== 'running') {
      await startSync(root);
    } else if (dashboard.sync.state === 'running') {
      schedulePoll(root);
    }
  } catch (error: unknown) {
    root.innerHTML = `<div class="empty">読込に失敗しました: ${esc(message(error))}</div>`;
  }
}

function render(root: HTMLElement, data: Dashboard): void {
  const latest = data.inventory[0];
  const maxWeeklyCost = Math.max(0.000001, ...data.weekly.map((row) => row.cost_usd));
  root.innerHTML = `
    <div class="llm-head">
      <div><h2>LLM 観測所</h2><p class="muted">AIアドバイスとは分離した、利用量・コスト・知識資産のローカル記録です。</p></div>
      <button id="llmRefresh" class="primary" ${data.sync.state === 'running' ? 'disabled' : ''}>${data.sync.state === 'running' ? '集計中…' : 'ログを更新'}</button>
    </div>
    ${syncBanner(data)}
    <section class="llm-section">
      <h3>今日の利用</h3>
      <div class="llm-metrics">
        ${metricCard('等価 API コスト', usd(data.today.cost_usd), '推定')}
        ${metricCard('トークン', compact(data.today.total_tokens), 'cache込み')}
        ${metricCard('キャッシュヒット率', percent(data.today.cache_hit_rate), '')}
        ${metricCard('セッション', number(data.today.sessions), '')}
        ${metricCard('コンテキスト', number(data.today.contexts), 'usage/turn')}
      </div>
    </section>
    <section class="llm-section">
      <h3>保存済み総計 <span class="muted">${esc(data.total.date_from || '—')} 〜 ${esc(data.total.date_to || '—')}</span></h3>
      <div class="llm-metrics compact">
        ${metricCard('総コスト', usd(data.total.cost_usd), '等価 API')}
        ${metricCard('総トークン', compact(data.total.total_tokens), '')}
        ${metricCard('総セッション', number(data.total.sessions), '')}
        ${metricCard('総コンテキスト', number(data.total.contexts), '')}
      </div>
    </section>
    <section class="llm-section">
      <h3>日別ログ</h3>
      <div class="llm-table-wrap"><table class="llm-table llm-daily-table"><thead><tr>
        <th>日付</th><th class="num">USD</th><th class="num">Tokens</th><th class="num">Cache</th>
        <th class="num">Sessions</th><th class="num">Contexts</th>
      </tr></thead><tbody>${data.daily.slice(0, 31).map((row) => `<tr>
        <td>${esc(row.date)}</td><td class="num">${usd(row.cost_usd)}</td><td class="num">${compact(row.total_tokens)}</td>
        <td class="num">${percent(row.cache_hit_rate)}</td><td class="num">${number(row.sessions)}</td><td class="num">${number(row.contexts)}</td>
      </tr>`).join('')}</tbody></table></div>
    </section>
    <section class="llm-section">
      <h3>週刊利用料の推移</h3>
      <div class="llm-weekly">${data.weekly.length ? data.weekly.map((row) => `
        <div class="llm-week-row">
          <span>${esc(row.week)}</span>
          <div class="llm-week-track"><i style="width:${Math.max(2, row.cost_usd / maxWeeklyCost * 100).toFixed(1)}%"></i></div>
          <strong>${usd(row.cost_usd)}</strong>
          <small>${compact(row.tokens)} tok / ${number(row.contexts)} ctx</small>
        </div>`).join('') : '<div class="empty">更新すると週次データが蓄積されます。</div>'}</div>
    </section>
    <section class="llm-section">
      <h3>能力資産</h3>
      ${latest ? `<div class="llm-metrics compact">
        ${inventoryCard('スキル', latest.skills)}
        ${inventoryCard('メモリ', latest.memories)}
        ${inventoryCard('Geniusカード', latest.genius_cards)}
        ${inventoryCard('判断ログ', latest.judgment_logs)}
      </div>${renderLocalLlms(latest)}` : '<div class="empty">まだ資産スナップショットがありません。</div>'}
    </section>
    <section class="llm-section">
      <h3>セッションごとの利用</h3>
      <div class="llm-table-wrap"><table class="llm-table"><thead><tr>
        <th>Session</th><th>Provider / Model</th><th>期間</th><th class="num">Contexts</th>
        <th class="num">Tokens</th><th class="num">Cache</th><th class="num">USD</th>
      </tr></thead><tbody>${data.sessions.map(sessionRow).join('')}</tbody></table></div>
    </section>
    <p class="llm-method muted">コスト算式: ${esc(data.methodology.reference)}。実請求額ではありません。初回は直近 ${data.methodology.initial_import_days} 日を取り込み、以後 Memoria に蓄積します。</p>`;
  root.querySelector('#llmRefresh')?.addEventListener('click', () => void startSync(root));
}

async function startSync(root: HTMLElement): Promise<void> {
  try {
    await getJson('/api/llm-usage/sync', { method: 'POST' });
  } catch (error: unknown) {
    root.insertAdjacentHTML('afterbegin', `<div class="llm-sync error">更新開始に失敗: ${esc(message(error))}</div>`);
    return;
  }
  schedulePoll(root);
  try {
    await refresh(root);
  } catch (error: unknown) {
    root.insertAdjacentHTML('afterbegin', `<div class="llm-sync error">更新状況の読込に失敗: ${esc(message(error))}</div>`);
  }
}

function schedulePoll(root: HTMLElement): void {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(async () => {
    pollTimer = null;
    try {
      const dashboard = await refresh(root);
      if (dashboard.sync.state === 'running') schedulePoll(root);
    } catch (error: unknown) {
      root.insertAdjacentHTML('afterbegin', `<div class="llm-sync error">更新状況の読込に失敗: ${esc(message(error))}</div>`);
    }
  }, 1500);
}

async function refresh(root: HTMLElement): Promise<Dashboard> {
  const data = await getJson<Dashboard>('/api/llm-usage');
  render(root, data);
  return data;
}

function syncBanner(data: Dashboard): string {
  if (data.sync.state === 'running') {
    return `<div class="llm-sync">native JSONL を集計中 ${number(data.sync.progress.current)} / ${number(data.sync.progress.total)}</div>`;
  }
  if (data.sync.state === 'failed') return `<div class="llm-sync error">集計失敗: ${esc(data.sync.error || 'unknown')}</div>`;
  const failed = Number(data.sources.failed) || 0;
  return `<div class="llm-sync muted">最終保存: ${esc(data.sources.last_imported_at || '未実行')} / sources ${number(data.sources.total)}${failed ? ` / failed ${number(failed)}` : ''}</div>`;
}

function sessionRow(row: SessionRow): string {
  const id = row.session_id.length > 20 ? `${row.session_id.slice(0, 8)}…${row.session_id.slice(-6)}` : row.session_id;
  const period = `${shortDate(row.started_at)} 〜 ${shortDate(row.ended_at)}`;
  return `<tr title="${esc(row.cost_basis || '')}">
    <td><code>${esc(id)}</code><small>${esc(row.repo_name || '')}</small></td>
    <td>${esc(row.provider)}<small>${esc(row.models || 'unknown')}${row.efforts && row.efforts !== 'unknown' ? ` / ${esc(row.efforts)}` : ''}</small></td>
    <td>${esc(period)}</td><td class="num">${number(row.contexts)}</td>
    <td class="num">${compact(row.total_tokens)}</td><td class="num">${percent(row.cache_hit_rate)}</td><td class="num">${usd(row.cost_usd)}</td>
  </tr>`;
}

function renderLocalLlms(row: InventoryRow): string {
  if (!row.local_llms.length) return '<div class="llm-local muted">Local LLM は未設定です。</div>';
  return `<div class="llm-local">${row.local_llms.map((runtime) => `
    <span class="llm-status ${runtime.available ? 'ok' : 'ng'}">${runtime.available ? '● 利用可能' : '● 接続不可'}</span>
    <strong>${esc(runtime.configuredModel || 'model未指定')}</strong>
    <span class="muted">${runtime.models.map((m) => esc(m.id)).join(', ') || 'モデル一覧なし'}</span>
  `).join('')}</div>`;
}

function metricCard(label: string, value: string, note: string): string {
  return `<div class="llm-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong>${note ? `<small>${esc(note)}</small>` : ''}</div>`;
}

function inventoryCard(label: string, metric: Metric): string {
  const delta = metric.delta == null ? '比較なし' : metric.delta === 0 ? '±0' : metric.delta > 0 ? `+${metric.delta}` : String(metric.delta);
  return `<div class="llm-metric"><span>${esc(label)}</span><strong>${metric.value == null ? '—' : number(metric.value)}</strong><small class="${(metric.delta || 0) > 0 ? 'up' : (metric.delta || 0) < 0 ? 'down' : ''}">${esc(delta)}</small></div>`;
}

async function getJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error || `HTTP ${response.status}`);
  return body as T;
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char);
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function number(value: unknown): string { return new Intl.NumberFormat('ja-JP').format(Number(value) || 0); }
function compact(value: unknown): string { return new Intl.NumberFormat('ja-JP', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value) || 0); }
function usd(value: unknown): string { return `$${(Number(value) || 0).toFixed((Number(value) || 0) < 10 ? 3 : 2)}`; }
function percent(value: unknown): string { return typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—'; }
function shortDate(value: string | null): string { return value ? new Date(value).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }
