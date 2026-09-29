interface Metric { value: number | null; delta: number | null }
interface InventoryRow {
  date: string;
  captured_at: string;
  skills: Metric;
  memories: Metric;
  genius_cards: Metric;
  judgment_logs: Metric;
  local_llms: Array<{ configuredModel: string; available: boolean; models: Array<{ id: string }> }>;
}
interface UsageSummary {
  sessions: number;
  contexts: number;
  responses: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  cache_write_unknown_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** Official API list-price equivalent of priced responses only. */
  cost_usd: number;
  cost_input_usd: number;
  cost_cache_read_usd: number;
  cost_cache_write_usd: number;
  cost_output_usd: number;
  unpriced_responses: number;
  unpriced_tokens: number;
  codex_credits: number | null;
  codex_uncredited_responses: number;
  cache_hit_rate: number | null;
  date_from?: string | null;
  date_to?: string | null;
}
interface ModelRow extends UsageSummary { provider: string; model: string; cost_basis: string }
interface PeriodView {
  from: string;
  to: string;
  summary: UsageSummary;
  by_model: ModelRow[];
  sessions_total: number;
  sessions_truncated: boolean;
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
  subagents: number;
}
interface DailyRow extends UsageSummary { date: string }
interface WeeklyRow { week: string; cost_usd: number; tokens: number; sessions: number; contexts: number }
interface Dashboard {
  today: UsageSummary;
  total: UsageSummary;
  daily: DailyRow[];
  weekly: WeeklyRow[];
  period: PeriodView;
  sessions: SessionRow[];
  inventory: InventoryRow[];
  sources: { total: number; failed: number; last_imported_at: string | null };
  legacy: { records: number; date_from: string | null; date_to: string | null };
  methodology: { price_version: string; initial_import_days: number };
  sync: { state: string; progress: { current: number; total: number }; error: string | null };
}

let pollTimer: number | null = null;
/** Selected JST period; null means the server default (last 7 days). */
let selectedPeriod: { from: string; to: string } | null = null;

export async function loadLlmView(): Promise<void> {
  const root = document.getElementById('llmRoot');
  if (!root) return;
  root.innerHTML = '<div class="empty">LLM 利用ログを読み込んでいます…</div>';
  try {
    const dashboard = await getJson<Dashboard>(dashboardUrl());
    render(root, dashboard);
    if (dashboard.sync.state === 'running') {
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
        ${metricCard('公式API換算', usd(data.today.cost_usd), unpricedNote(data.today))}
        ${metricCard('トークン', compact(data.today.total_tokens), 'cache込み')}
        ${metricCard('キャッシュヒット率', percent(data.today.cache_hit_rate), '')}
        ${metricCard('セッション', number(data.today.sessions), '')}
        ${metricCard('コンテキスト', number(data.today.contexts), 'usage/turn')}
      </div>
    </section>
    <section class="llm-section">
      <h3>保存済み総計 <span class="muted">${esc(data.total.date_from || '—')} 〜 ${esc(data.total.date_to || '—')}</span></h3>
      <div class="llm-metrics compact">
        ${metricCard('総コスト', usd(data.total.cost_usd), unpricedNote(data.total))}
        ${metricCard('総トークン', compact(data.total.total_tokens), '')}
        ${metricCard('総セッション', number(data.total.sessions), '')}
        ${metricCard('総コンテキスト', number(data.total.contexts), '')}
      </div>
    </section>
    ${renderPeriod(data.period)}
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
      <h3>セッションごとの利用 <span class="muted">${esc(data.period.from)} 〜 ${esc(data.period.to)}${data.period.sessions_truncated ? ` / 最新 ${number(data.sessions.length)} 件を表示 (全 ${number(data.period.sessions_total)} 件は期間集計に含む)` : ''}</span></h3>
      <div class="llm-table-wrap"><table class="llm-table"><thead><tr>
        <th>Session</th><th>Provider / Model</th><th>期間</th><th class="num">Contexts</th>
        <th class="num">Tokens</th><th class="num">Cache</th><th class="num">USD</th>
      </tr></thead><tbody>${data.sessions.map(sessionRow).join('')}</tbody></table></div>
    </section>
    <p class="llm-method muted">コストは公式 API 定価による換算 (料金表 ${esc(data.methodology.price_version)}) で、実請求額・サブスク枠の消費ではありません。Codex credits は別単位です。料金未掲載モデルは未評価として合算しません。TTL 不明の cache write は 5 分書込単価 (下限) で換算します。初回は直近 ${data.methodology.initial_import_days} 日を取り込み、以後 Memoria に蓄積します。${data.legacy.records ? ` 旧集計 ${number(data.legacy.records)} 行 (${esc(data.legacy.date_from || '—')}〜${esc(data.legacy.date_to || '—')}) は応答単位で再評価できないため表示に含めません。` : ''}</p>`;
  root.querySelector('#llmRefresh')?.addEventListener('click', () => void startSync(root));
  root.querySelector<HTMLFormElement>('#llmPeriodForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const from = (form.elements.namedItem('from') as HTMLInputElement).value;
    const to = (form.elements.namedItem('to') as HTMLInputElement).value;
    selectedPeriod = from && to ? { from, to } : null;
    void loadLlmView();
  });
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
  const data = await getJson<Dashboard>(dashboardUrl());
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

function dashboardUrl(): string {
  if (!selectedPeriod) return '/api/llm-usage';
  return `/api/llm-usage?${new URLSearchParams(selectedPeriod).toString()}`;
}

function renderPeriod(period: PeriodView): string {
  const summary = period.summary;
  const credits = summary.codex_credits == null ? '—' : number(Math.round(summary.codex_credits));
  const creditNote = summary.codex_uncredited_responses
    ? `credit 未掲載 ${number(summary.codex_uncredited_responses)} 応答`
    : 'API USD とは別単位';
  return `<section class="llm-section">
    <h3>期間集計 <span class="muted">${esc(period.from)} 00:00 〜 ${esc(period.to)} 24:00 JST</span></h3>
    <form id="llmPeriodForm" class="llm-period foundation-form">
      <label>開始 <input type="date" name="from" value="${esc(period.from)}" required></label>
      <label>終了 <input type="date" name="to" value="${esc(period.to)}" required></label>
      <button type="submit">表示</button>
    </form>
    <div class="llm-metrics compact">
      ${metricCard('公式API換算', usd(summary.cost_usd), unpricedNote(summary))}
      ${metricCard('応答数', number(summary.responses), '重複除去済み')}
      ${metricCard('セッション', number(period.sessions_total), '親+サブエージェント')}
      ${metricCard('Codex credits', credits, creditNote)}
    </div>
    <div class="llm-table-wrap"><table class="llm-table"><thead><tr>
      <th>Model</th><th class="num">応答</th><th class="num">Input</th><th class="num">Cache read</th>
      <th class="num">Cache write 5m / 1h / 不明</th><th class="num">Output</th>
      <th class="num">Input $</th><th class="num">Cache read $</th><th class="num">Cache write $</th>
      <th class="num">Output $</th><th class="num">合計 $</th>
    </tr></thead><tbody>${[
      ...period.by_model.map(modelRow),
      modelRow({ ...summary, provider: '', model: '合計', cost_basis: '' }),
    ].join('')}</tbody></table></div>
  </section>`;
}

function modelRow(row: ModelRow): string {
  const priced = row.unpriced_responses < row.responses;
  const cost = (value: number): string => (priced ? usd(value) : '未評価');
  return `<tr title="${esc(row.cost_basis || '')}">
    <td>${esc(row.model)}<small>${esc(row.provider)}</small></td><td class="num">${number(row.responses)}</td>
    <td class="num">${number(row.input_tokens)}</td><td class="num">${number(row.cache_read_tokens)}</td>
    <td class="num">${number(row.cache_write_5m_tokens)} / ${number(row.cache_write_1h_tokens)} / ${number(row.cache_write_unknown_tokens)}</td>
    <td class="num">${number(row.output_tokens)}</td>
    <td class="num">${cost(row.cost_input_usd)}</td><td class="num">${cost(row.cost_cache_read_usd)}</td>
    <td class="num">${cost(row.cost_cache_write_usd)}</td><td class="num">${cost(row.cost_output_usd)}</td>
    <td class="num">${cost(row.cost_usd)}${row.unpriced_responses && priced ? `<small>未評価 ${number(row.unpriced_responses)}</small>` : ''}</td>
  </tr>`;
}

function unpricedNote(summary: UsageSummary): string {
  return summary.unpriced_responses
    ? `未評価 ${number(summary.unpriced_responses)} 応答 / ${compact(summary.unpriced_tokens)} tok`
    : '推定・実請求ではない';
}

function sessionRow(row: SessionRow): string {
  const id = row.session_id.length > 20 ? `${row.session_id.slice(0, 8)}…${row.session_id.slice(-6)}` : row.session_id;
  const period = `${shortDate(row.started_at)} 〜 ${shortDate(row.ended_at)}`;
  return `<tr title="${esc(row.cost_basis || '')}">
    <td><code>${esc(id)}</code><small>${esc(row.repo_name || '')}</small></td>
    <td>${esc(row.provider)}<small>${esc(row.models || 'unknown')}${row.efforts && row.efforts !== 'unknown' ? ` / ${esc(row.efforts)}` : ''}${row.subagents ? ` / subagents ${number(row.subagents)}` : ''}</small></td>
    <td>${esc(period)}</td><td class="num">${number(row.contexts)}</td>
    <td class="num">${compact(row.total_tokens)}</td><td class="num">${percent(row.cache_hit_rate)}</td><td class="num">${usd(row.cost_usd)}${row.unpriced_responses ? '<small>一部未評価</small>' : ''}</td>
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
