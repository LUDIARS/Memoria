import type {
  CleverSearchHistoryResponse,
  CleverSearchResponse,
} from '../../api/types/clever-search.js';
import type {
  CleverSearchCategoryReport,
  CleverSearchCitation,
  CleverSearchReport,
} from '../../clever-search/types.js';

const SOURCE_LABELS: Record<string, string> = {
  activity: '活動',
  external_chat: '会話',
  bookmark: 'ブックマーク',
  dig: 'Dig',
  dictionary: '辞書',
  note: 'ノート',
  diary: '日記',
  weekly_report: '週報',
  task: 'タスク',
  implementation_note: '改善記録',
};

let initialized = false;

function element<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function displayDate(value: string | null): string {
  if (!value) return '日時不明';
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(date);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null) as ({ error?: string } & T) | null;
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  if (!payload) throw new Error('空のレスポンスを受信しました');
  return payload;
}

function citationHtml(citation: CleverSearchCitation): string {
  const source = SOURCE_LABELS[citation.sourceType] ?? citation.sourceType;
  const subtype = citation.sourceSubtype ? ` · ${escapeHtml(citation.sourceSubtype)}` : '';
  return `<li class="clever-search-citation">
    <div class="clever-search-citation-head">
      <span class="clever-search-source">${escapeHtml(source)} #${escapeHtml(citation.sourceId)}${subtype}</span>
      <time>${escapeHtml(displayDate(citation.occurredAt))}</time>
    </div>
    <strong>${escapeHtml(citation.title)}</strong>
    <blockquote>${escapeHtml(citation.excerpt)}</blockquote>
  </li>`;
}

function categoryHtml(category: CleverSearchCategoryReport, categoryIndex: number): string {
  const breakdown = category.sourceBreakdown
    .map((item) => `${escapeHtml(SOURCE_LABELS[item.sourceType] ?? item.sourceType)} ${item.count}`)
    .join(' / ');
  return `<article class="clever-search-category">
    <header>
      <div>
        <h3>${escapeHtml(category.label)}</h3>
        <p>${escapeHtml(category.summary)}</p>
      </div>
      <span class="clever-search-count">${category.count}件</span>
    </header>
    <div class="clever-search-breakdown">${breakdown}</div>
    <h4>ランダム代表引用</h4>
    <ul class="clever-search-representatives">
      ${category.representatives.map(citationHtml).join('')}
    </ul>
    <details class="clever-search-all-citations" data-category-index="${categoryIndex}">
      <summary>全引用 ${category.citations.length}件を展開</summary>
      <ul data-citation-list></ul>
    </details>
  </article>`;
}

function reportHtml(report: CleverSearchReport, cached: boolean, reportId: number, retrievalElapsedMs: number): string {
  const cacheLabel = cached ? 'キャッシュ' : '新規作成';
  const period = report.firstOccurredAt
    ? `${displayDate(report.firstOccurredAt)} 〜 ${displayDate(report.lastOccurredAt)}`
    : '該当期間なし';
  const timeline = report.timeline.length > 0
    ? report.timeline.map((item) => `<li><span>${escapeHtml(item.month)}</span><b>${item.count}</b></li>`).join('')
    : '<li class="muted">該当なし</li>';

  return `<section class="clever-search-report-head">
    <div class="clever-search-report-title">
      <div>
        <span class="clever-search-cache-badge" data-cached="${cached ? 'true' : 'false'}">${cacheLabel}</span>
        <span class="muted">Report #${reportId}</span>
      </div>
      <h2>「${escapeHtml(report.query)}」</h2>
      <p>${escapeHtml(report.summary)}</p>
    </div>
    <dl class="clever-search-stats">
      <div><dt>一致</dt><dd>${report.totalHits}件</dd></div>
      <div><dt>記録期間</dt><dd>${escapeHtml(period)}</dd></div>
      <div><dt>検索</dt><dd>${report.searchElapsedMs}ms</dd></div>
      <div><dt>応答</dt><dd>${retrievalElapsedMs}ms</dd></div>
    </dl>
    <details class="clever-search-timeline">
      <summary>月別タイムライン</summary>
      <ul>${timeline}</ul>
    </details>
  </section>
  <section class="clever-search-categories">
    ${report.categories.length > 0
      ? report.categories.map(categoryHtml).join('')
      : '<div class="empty">一致するログはありませんでした。</div>'}
  </section>`;
}

function attachDeferredCitationRendering(
  result: HTMLElement,
  categories: CleverSearchCategoryReport[],
): void {
  const detailsList = result.querySelectorAll<HTMLDetailsElement>('.clever-search-all-citations');
  for (const details of detailsList) {
    details.addEventListener('toggle', () => {
      if (!details.open || details.dataset.loaded === 'true') return;
      const categoryIndex = Number(details.dataset.categoryIndex);
      const category = categories[categoryIndex];
      const list = details.querySelector<HTMLElement>('[data-citation-list]');
      if (!category || !list) return;
      list.innerHTML = category.citations.map(citationHtml).join('');
      details.dataset.loaded = 'true';
    });
  }
}

function renderResponse(response: CleverSearchResponse): void {
  const result = element<HTMLElement>('cleverSearchResult');
  if (!result) return;
  result.innerHTML = reportHtml(
    response.report,
    response.cached,
    response.reportId,
    response.retrievalElapsedMs,
  );
  attachDeferredCitationRendering(result, response.report.categories);
  result.hidden = false;
}

function setBusy(busy: boolean, message = ''): void {
  const button = element<HTMLButtonElement>('cleverSearchSubmit');
  const status = element<HTMLElement>('cleverSearchStatus');
  if (button) button.disabled = busy;
  if (status) status.textContent = message;
}

async function runSearch(): Promise<void> {
  const input = element<HTMLInputElement>('cleverSearchQuery');
  const refresh = element<HTMLInputElement>('cleverSearchRefresh');
  const query = input?.value.trim() ?? '';
  if (!query) {
    input?.focus();
    setBusy(false, '検索語を入力してください');
    return;
  }
  setBusy(true, 'ローカル索引を検索中…');
  try {
    const response = await fetchJson<CleverSearchResponse>('/api/clever-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, refresh: refresh?.checked ?? false }),
    });
    renderResponse(response);
    setBusy(false, `${response.cached ? 'キャッシュから表示' : 'レポートを作成'} · ${response.retrievalElapsedMs}ms`);
    await loadCleverSearchHistory();
  } catch (error: unknown) {
    setBusy(false, `検索失敗: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadReport(id: number): Promise<void> {
  setBusy(true, `Report #${id} を読込中…`);
  try {
    const response = await fetchJson<CleverSearchResponse>(`/api/clever-search/reports/${id}`);
    const input = element<HTMLInputElement>('cleverSearchQuery');
    if (input) input.value = response.report.query;
    renderResponse(response);
    setBusy(false, '保存済みレポートを表示');
  } catch (error: unknown) {
    setBusy(false, `レポート読込失敗: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadCleverSearchHistory(): Promise<void> {
  const history = element<HTMLElement>('cleverSearchHistory');
  if (!history) return;
  try {
    const response = await fetchJson<CleverSearchHistoryResponse>('/api/clever-search/reports?limit=30');
    history.innerHTML = response.items.length > 0
      ? response.items.map((item) => `<li>
          <button type="button" data-report-id="${item.id}">
            <span>${escapeHtml(item.query)}</span>
            <small>${item.totalHits}件 · ${escapeHtml(displayDate(item.createdAt))}</small>
          </button>
        </li>`).join('')
      : '<li class="muted">保存済みレポートはありません</li>';
  } catch (error: unknown) {
    history.innerHTML = `<li class="muted">履歴取得失敗: ${escapeHtml(error instanceof Error ? error.message : String(error))}</li>`;
  }
}

export function initCleverSearchView(): void {
  if (initialized) return;
  initialized = true;
  element<HTMLFormElement>('cleverSearchForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void runSearch();
  });
  element<HTMLElement>('cleverSearchHistory')?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-report-id]');
    const id = Number(button?.dataset.reportId);
    if (Number.isSafeInteger(id) && id > 0) void loadReport(id);
  });
}
