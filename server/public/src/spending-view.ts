/**
 * 📝 ログ タブの 「レシート」 「クレカ」 「消費傾向」 サブビュー。
 *
 * 支出ログは `sensitive.financial_location` なので、 この画面は同一マシンからのみ
 * 応答が返る API (/api/spending-logs*) だけを叩き、 Hub 側データソースは参照しない。
 */

type SourceKind = 'receipt' | 'transaction';

interface SpendingPlace {
  name: string | null;
  google_maps_url: string | null;
  location: { latitude: number; longitude: number; accuracy_m: number | null } | null;
}

interface SpendingItem {
  name: string;
  price: number;
  quantity: number | null;
  category: string;
}

interface SpendingRecord {
  id: string;
  source_kind: SourceKind;
  date: string;
  occurred_at: string | null;
  amount: number;
  currency: string;
  place: SpendingPlace;
  payment: { kind: string; label: string | null };
  items: SpendingItem[];
  purchase_category: string;
}

interface SpendingListResponse {
  records: SpendingRecord[];
  count: number;
}

interface StayEvidence {
  record_id: string;
  status: 'confirmed_by_gps' | 'time_matched' | 'conflict' | 'no_gps';
  distance_m: number | null;
  nearest_gps: { recorded_at: string; place_name: string | null } | null;
  enriched_place_name: string | null;
}

interface StaysResponse {
  days: Array<{ date: string; entries: StayEvidence[]; confirmed_count: number; conflict_count: number }>;
}

interface AmountBucket { key: string; label: string; amount: number; count: number; share: number }

interface SpendingAnalytics {
  currency: string;
  date_from: string;
  date_to: string;
  record_count: number;
  total_amount: number;
  daily_average: number;
  by_source_kind: AmountBucket[];
  by_purchase_category: AmountBucket[];
  by_payment: AmountBucket[];
  by_place: AmountBucket[];
  monthly_totals: Array<{ month: string; amount: number; count: number }>;
  month_over_month: { delta_amount: number; delta_ratio: number } | null;
  recurring_charges: Array<{ place_name: string | null; amount: number; months: string[] }>;
  outliers: Array<{ date: string; place_name: string | null; amount: number }>;
}

interface AdviceSettings { consent: boolean; base_url: string; model: string }

interface AdviceReport {
  id: number;
  date_from: string;
  date_to: string;
  currency: string;
  provider_label: string;
  model: string;
  advice_markdown: string;
  generated_at: string;
}

const STAY_BADGES: Record<StayEvidence['status'], { label: string; title: string }> = {
  confirmed_by_gps: { label: '📍 GPS 一致', title: '同時刻の GPS 点が同じ場所にある' },
  time_matched: { label: '🕒 時刻のみ', title: '時刻は合うが座標では確認できていない' },
  conflict: { label: '⚠ 位置ずれ', title: '同時刻の GPS 点が離れている (通販 / 後日計上の可能性)' },
  no_gps: { label: '— GPS なし', title: '同時刻の GPS 点が無い' },
};

let cachedStays: Map<string, StayEvidence> = new Map();
let selectedSpendingCurrency: string | null = null;

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`);
  return await res.json() as T;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch
  ));
}

function money(amount: number, currency: string): string {
  return `${amount.toLocaleString('ja-JP')} ${escapeHtml(currency)}`;
}

function externalHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function hhmm(iso: string | null): string {
  if (!iso) return '--:--';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '--:--';
  return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
}

/** レシート / クレカ サブビューの本体。 1 日分を表示する。 */
export async function loadSpendingLogView(kind: SourceKind, date: string): Promise<void> {
  const listEl = document.getElementById(kind === 'receipt' ? 'wlReceiptList' : 'wlCardList');
  const summaryEl = document.getElementById(kind === 'receipt' ? 'wlReceiptSummary' : 'wlCardSummary');
  const emptyEl = document.getElementById(kind === 'receipt' ? 'wlReceiptEmpty' : 'wlCardEmpty');
  if (!listEl || !summaryEl || !emptyEl) return;

  try {
    const query = `date_from=${date}&date_to=${date}&source_kind=${kind}`;
    const [list, stays] = await Promise.all([
      fetchJson<SpendingListResponse>(`/api/spending-logs?${query}`),
      fetchJson<StaysResponse>(`/api/spending-logs/stays?date_from=${date}&date_to=${date}`),
    ]);
    cachedStays = new Map(
      stays.days.flatMap((day) => day.entries).map((entry) => [entry.record_id, entry]),
    );

    const totals = new Map<string, number>();
    for (const record of list.records) {
      totals.set(record.currency, (totals.get(record.currency) ?? 0) + record.amount);
    }
    const totalText = [...totals]
      .sort(([currencyA], [currencyB]) => currencyA.localeCompare(currencyB))
      .map(([currency, total]) => `<strong>${money(total, currency)}</strong>`)
      .join(' / ');
    summaryEl.innerHTML = list.records.length === 0
      ? ''
      : `合計 ${totalText} / ${list.records.length} 件`;
    listEl.innerHTML = list.records.map((record) => renderRecord(record, kind)).join('');
    emptyEl.classList.toggle('hidden', list.records.length > 0);
  } catch (err: unknown) {
    listEl.innerHTML = '';
    summaryEl.textContent = `取得失敗: ${(err as Error).message}`;
    emptyEl.classList.add('hidden');
  }
}

function renderRecord(record: SpendingRecord, kind: SourceKind): string {
  const stay = cachedStays.get(record.id);
  const badge = stay ? STAY_BADGES[stay.status] : null;
  const distance = stay?.distance_m !== null && stay?.distance_m !== undefined
    ? ` (${stay.distance_m} m)`
    : '';
  const place = record.place.name ?? '(店名不明)';
  const mapUrl = externalHttpUrl(record.place.google_maps_url);
  const mapLink = mapUrl
    ? ` <a href="${escapeHtml(mapUrl)}" target="_blank" rel="noreferrer">地図</a>`
    : '';
  const payment = record.payment.label ?? record.payment.kind;
  const items = kind === 'receipt' && record.items.length > 0
    ? `<ul class="wl-sublist">${record.items.map((item) => `
        <li>${escapeHtml(item.name)} — ${money(item.price, record.currency)}${item.quantity ? ` ×${item.quantity}` : ''}</li>
      `).join('')}</ul>`
    : '';
  const enriched = stay?.enriched_place_name
    ? `<div class="muted" style="font-size:11px">GPS 側に場所名が無いため、 この店名で滞在を補強できます</div>`
    : '';

  return `
    <li class="wl-item">
      <div class="wl-item-head">
        <span class="wl-time">${hhmm(record.occurred_at)}</span>
        <strong>${escapeHtml(place)}</strong>${mapLink}
        <span class="grow"></span>
        <strong>${money(record.amount, record.currency)}</strong>
      </div>
      <div class="muted" style="font-size:12px">
        ${escapeHtml(payment)} / ${escapeHtml(record.purchase_category)}
        ${badge ? ` · <span title="${escapeHtml(badge.title)}">${badge.label}${distance}</span>` : ''}
      </div>
      ${enriched}
      ${items}
    </li>
  `;
}

/** 消費傾向サブビュー。 決定的な集計と、 同意済みならローカル LLM の助言を出す。 */
export async function loadSpendingTrendView(): Promise<void> {
  const root = document.getElementById('wlSpendingTrendView');
  if (!root) return;
  const body = root.querySelector('.spending-trend-body');
  if (!body) return;

  try {
    const currencyQuery = selectedSpendingCurrency
      ? `?currency=${encodeURIComponent(selectedSpendingCurrency)}`
      : '';
    const [analyticsResp, adviceResp] = await Promise.all([
      fetchJson<{ analytics: SpendingAnalytics; currencies: string[] }>(`/api/spending-logs/analytics${currencyQuery}`),
      fetchJson<{ settings: AdviceSettings; reports: AdviceReport[] }>('/api/spending-logs/advice'),
    ]);
    if (selectedSpendingCurrency && analyticsResp.currencies.length > 0
      && !analyticsResp.currencies.includes(selectedSpendingCurrency)) {
      selectedSpendingCurrency = analyticsResp.currencies[0];
      await loadSpendingTrendView();
      return;
    }
    const activeCurrency = analyticsResp.analytics.currency;
    selectedSpendingCurrency = analyticsResp.currencies.includes(activeCurrency) ? activeCurrency : null;
    body.innerHTML = renderCurrencySelector(analyticsResp.currencies, activeCurrency)
      + renderTrend(analyticsResp.analytics)
      + renderAdvicePanel(adviceResp.settings, adviceResp.reports, activeCurrency);
    bindCurrencySelector();
    bindAdviceControls(activeCurrency);
  } catch (err: unknown) {
    body.innerHTML = `<div class="queue-empty">取得失敗: ${escapeHtml((err as Error).message)}</div>`;
  }
}

function renderCurrencySelector(currencies: string[], activeCurrency: string): string {
  if (currencies.length <= 1) return '';
  return `
    <label class="spending-currency-select">
      通貨
      <select id="spendingCurrency">
        ${currencies.map((currency) => `
          <option value="${escapeHtml(currency)}" ${currency === activeCurrency ? 'selected' : ''}>
            ${escapeHtml(currency)}
          </option>
        `).join('')}
      </select>
    </label>
  `;
}

function bindCurrencySelector(): void {
  const select = document.getElementById('spendingCurrency') as HTMLSelectElement | null;
  select?.addEventListener('change', () => {
    selectedSpendingCurrency = select.value;
    void loadSpendingTrendView();
  });
}

function renderTrend(analytics: SpendingAnalytics): string {
  if (analytics.record_count === 0) {
    return '<div class="queue-empty">対象期間の支出ログがありません。 Quaestor から同期してください。</div>';
  }
  const mom = analytics.month_over_month;
  const momText = mom
    ? `${mom.delta_amount >= 0 ? '+' : ''}${money(mom.delta_amount, analytics.currency)} (${Math.round(mom.delta_ratio * 100)}%)`
    : '—';

  return `
    <div class="wl-summary-row">
      ${analytics.date_from} 〜 ${analytics.date_to} ·
      合計 <strong>${money(analytics.total_amount, analytics.currency)}</strong> ·
      1 日平均 ${money(analytics.daily_average, analytics.currency)} ·
      前月比 ${momText}
    </div>
    ${renderBuckets('分類別', analytics.by_purchase_category, analytics.currency)}
    ${renderBuckets('支払手段別', analytics.by_payment, analytics.currency)}
    ${renderBuckets('よく使う店', analytics.by_place, analytics.currency)}
    <h4>定期課金の候補</h4>
    ${analytics.recurring_charges.length === 0
      ? '<div class="queue-empty">該当なし</div>'
      : `<ul class="wl-list">${analytics.recurring_charges.map((charge) => `
          <li>${escapeHtml(charge.place_name ?? '(店名不明)')} — ${money(charge.amount, analytics.currency)} × ${charge.months.length} ヶ月</li>
        `).join('')}</ul>`}
    <h4>突出支出</h4>
    ${analytics.outliers.length === 0
      ? '<div class="queue-empty">該当なし</div>'
      : `<ul class="wl-list">${analytics.outliers.map((outlier) => `
          <li>${outlier.date} ${escapeHtml(outlier.place_name ?? '(店名不明)')} — ${money(outlier.amount, analytics.currency)}</li>
        `).join('')}</ul>`}
  `;
}

function renderBuckets(title: string, buckets: AmountBucket[], currency: string): string {
  if (buckets.length === 0) return '';
  return `
    <h4>${escapeHtml(title)}</h4>
    <ul class="wl-list">
      ${buckets.map((bucket) => `
        <li>${escapeHtml(bucket.label)} — ${money(bucket.amount, currency)} (${bucket.count} 件 / ${Math.round(bucket.share * 100)}%)</li>
      `).join('')}
    </ul>
  `;
}

function renderAdvicePanel(settings: AdviceSettings, reports: AdviceReport[], currency: string): string {
  const latest = reports.find((report) => report.currency === currency);
  return `
    <h4>消費傾向の助言 (ローカル LLM)</h4>
    <div class="foundation-form spending-advice-settings">
      <label>
        <input type="checkbox" id="spendingAdviceConsent" ${settings.consent ? 'checked' : ''} />
        支出ログをローカル LLM に渡して助言を生成することに同意する
      </label>
      <div class="muted" style="font-size:11px">
        同意すると llm_relay_scope が diary_and_spending_advice に昇格します。 送信先は
        loopback (${escapeHtml(settings.base_url)} / ${escapeHtml(settings.model)}) に限定され、
        クラウド LLM へは送られません。 同意を外すと昇格済みの行は diary_only に戻ります。
      </div>
      <button id="spendingAdviceRun" class="ghost" ${settings.consent ? '' : 'disabled'}>助言を生成</button>
      <span id="spendingAdviceStatus" class="muted"></span>
    </div>
    ${latest ? `
      <div class="spending-advice-report">
        <div class="muted" style="font-size:11px">
          ${escapeHtml(latest.date_from)} 〜 ${escapeHtml(latest.date_to)} ·
          ${escapeHtml(latest.provider_label)} / ${escapeHtml(latest.model)} ·
          ${escapeHtml(latest.generated_at)}
        </div>
        <pre class="spending-advice-markdown">${escapeHtml(latest.advice_markdown)}</pre>
      </div>
    ` : '<div class="queue-empty">まだ助言はありません。</div>'}
  `;
}

function bindAdviceControls(currency: string): void {
  const consent = document.getElementById('spendingAdviceConsent') as HTMLInputElement | null;
  const run = document.getElementById('spendingAdviceRun') as HTMLButtonElement | null;
  const status = document.getElementById('spendingAdviceStatus');

  consent?.addEventListener('change', () => {
    void (async () => {
      try {
        await fetchJson('/api/spending-logs/advice/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ consent: consent.checked }),
        });
        await loadSpendingTrendView();
      } catch (err: unknown) {
        if (status) status.textContent = `設定更新に失敗: ${(err as Error).message}`;
      }
    })();
  });

  run?.addEventListener('click', () => {
    void (async () => {
      run.disabled = true;
      if (status) status.textContent = '生成中… (ローカル LLM)';
      try {
        await fetchJson('/api/spending-logs/advice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currency }),
        });
        await loadSpendingTrendView();
      } catch (err: unknown) {
        if (status) status.textContent = `生成に失敗: ${(err as Error).message}`;
        run.disabled = false;
      }
    })();
  });
}
