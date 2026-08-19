type SourceKind = 'flyer' | 'online' | 'sale';
type ShippingMode = 'page' | 'free' | 'in_store' | 'flat';

interface ShoppingSource {
  id: string;
  name: string;
  kind: SourceKind;
  pageUrl: string;
  searchUrlTemplate: string | null;
  shippingMode: ShippingMode;
  flatShippingYen: number | null;
  enabled: boolean;
}

interface ShoppingConfig {
  defaultsVersion: number;
  enabled: boolean;
  refreshHour: number;
  maxItemsPerSource: number;
  sources: ShoppingSource[];
}

interface ShoppingOffer {
  sourceId: string;
  sourceName: string;
  title: string;
  url: string;
  priceYen: number;
  shippingYen: number | null;
  totalYen: number | null;
  saleLabel: string | null;
}

interface SourceFailure {
  sourceName: string;
  message: string;
}

interface ShoppingDigest {
  date: string;
  generatedAt: string;
  items: ShoppingOffer[];
  failures: SourceFailure[];
}

interface ShoppingSearchResult {
  query: string;
  searchedAt: string;
  winner: ShoppingOffer | null;
  offers: ShoppingOffer[];
  failures: SourceFailure[];
}

let initialized = false;
let config: ShoppingConfig | null = null;

function root(): HTMLElement | null {
  return document.getElementById('shoppingRoot');
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function yen(value: number): string {
  return `${Math.round(value).toLocaleString('ja-JP')}円`;
}

function shippingText(offer: ShoppingOffer): string {
  if (offer.shippingYen === null) return '送料未確認（最安判定から除外）';
  if (offer.shippingYen === 0) return '送料 0円';
  return `送料 ${yen(offer.shippingYen)}`;
}

function offerCard(offer: ShoppingOffer, winner = false): string {
  const total = offer.totalYen === null ? '総額未確定' : `総額 ${yen(offer.totalYen)}`;
  return `<article class="shopping-offer${winner ? ' shopping-winner' : ''}">
    <div class="shopping-offer-source">${escapeHtml(offer.sourceName)}${winner ? ' · 最安' : ''}</div>
    <h4><a href="${escapeHtml(offer.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(offer.title)}</a></h4>
    <div class="shopping-price"><strong>${escapeHtml(total)}</strong><span>商品 ${yen(offer.priceYen)} / ${escapeHtml(shippingText(offer))}</span></div>
    ${offer.saleLabel ? `<span class="shopping-sale-label">${escapeHtml(offer.saleLabel)}</span>` : ''}
  </article>`;
}

function failuresHtml(failures: SourceFailure[]): string {
  if (failures.length === 0) return '';
  return `<details class="shopping-failures"><summary>取得できなかった店舗 ${failures.length}件</summary><ul>${failures
    .map((failure) => `<li><strong>${escapeHtml(failure.sourceName)}</strong>: ${escapeHtml(failure.message)}</li>`)
    .join('')}</ul></details>`;
}

function renderDigest(digest: ShoppingDigest | null): void {
  const output = document.getElementById('shoppingDeals');
  if (!output) return;
  if (!digest) {
    output.innerHTML = '<div class="empty">まだお買い得ニュースがありません。「今すぐ更新」でチラシとセールを取得してください。</div>';
    return;
  }
  output.innerHTML = `<p class="shopping-digest-date">${escapeHtml(digest.date)} のお買い得ニュース · ${new Date(digest.generatedAt).toLocaleString('ja-JP')}</p>
    <div class="shopping-offer-grid">${digest.items.map((offer) => offerCard(offer)).join('')}</div>
    ${failuresHtml(digest.failures)}`;
}

function renderSearch(result: ShoppingSearchResult): void {
  const output = document.getElementById('shoppingResults');
  if (!output) return;
  const headline = result.winner
    ? `<div class="shopping-answer">「${escapeHtml(result.query)}」は <strong>${escapeHtml(result.winner.sourceName)}</strong> が送料込み <strong>${yen(result.winner.totalYen as number)}</strong> で最安です。</div>`
    : '<div class="shopping-answer shopping-answer-warn">送料まで確認できた候補がないため、最安店を断定できません。</div>';
  output.innerHTML = `${headline}
    <p class="shopping-caution">容量・個数・会員条件・配送先で金額が変わる場合があります。購入画面の最終総額も確認してください。</p>
    <div class="shopping-offer-grid">${result.offers.map((offer) => offerCard(offer,
      result.winner !== null
      && offer.sourceId === result.winner.sourceId
      && offer.url === result.winner.url
      && offer.totalYen === result.winner.totalYen,
    )).join('')}</div>
    ${result.offers.length === 0 ? '<div class="empty">該当商品が見つかりませんでした。</div>' : ''}
    ${failuresHtml(result.failures)}`;
}

function sourceSetupNote(source: ShoppingSource): string {
  if (source.id === 'aeon-netsuper') {
    return '<p class="shopping-caution shopping-source-wide">初期状態は無効です。配送先の担当店舗URLと、そのURLに <code>search/?q={query}</code> を付けた検索URLを設定してから有効にしてください。</p>';
  }
  if (source.id === 'maruetsu-online-delivery') {
    return '<p class="shopping-caution shopping-source-wide">初期状態は無効です。公開見学店の価格なので、表示店舗と配送先担当店舗が一致する場合だけ有効にしてください。送料は注文条件で変わるため未確定扱いです。</p>';
  }
  return '';
}

function sourceRow(source: ShoppingSource): string {
  return `<div class="shopping-source-row" data-source-id="${escapeHtml(source.id)}">
    ${sourceSetupNote(source)}
    <label><span>使用</span><input data-field="enabled" type="checkbox" ${source.enabled ? 'checked' : ''}></label>
    <label><span>店舗名</span><input data-field="name" type="text" value="${escapeHtml(source.name)}"></label>
    <label><span>種別</span><select data-field="kind">
      <option value="flyer" ${source.kind === 'flyer' ? 'selected' : ''}>店頭チラシ</option>
      <option value="online" ${source.kind === 'online' ? 'selected' : ''}>ネットスーパー</option>
      <option value="sale" ${source.kind === 'sale' ? 'selected' : ''}>通販セール</option>
    </select></label>
    <label class="shopping-source-wide"><span>チラシ／セール URL</span><input data-field="pageUrl" type="url" value="${escapeHtml(source.pageUrl)}"></label>
    <label class="shopping-source-wide"><span>検索 URL（商品部分を {query} にする）</span><input data-field="searchUrlTemplate" type="text" value="${escapeHtml(source.searchUrlTemplate ?? '')}" placeholder="https://example.jp/search?q={query}"></label>
    <label><span>送料</span><select data-field="shippingMode">
      <option value="page" ${source.shippingMode === 'page' ? 'selected' : ''}>ページから読む</option>
      <option value="in_store" ${source.shippingMode === 'in_store' ? 'selected' : ''}>店頭（0円）</option>
      <option value="free" ${source.shippingMode === 'free' ? 'selected' : ''}>常に無料</option>
      <option value="flat" ${source.shippingMode === 'flat' ? 'selected' : ''}>固定額</option>
    </select></label>
    <label><span>固定送料（円）</span><input data-field="flatShippingYen" type="number" min="0" value="${source.flatShippingYen ?? ''}"></label>
    <button type="button" class="ghost shopping-source-remove">削除</button>
  </div>`;
}

function renderSources(): void {
  const list = document.getElementById('shoppingSources');
  if (!list || !config) return;
  list.innerHTML = config.sources.map(sourceRow).join('');
  list.querySelectorAll<HTMLButtonElement>('.shopping-source-remove').forEach((button) => {
    button.addEventListener('click', () => {
      const row = button.closest<HTMLElement>('.shopping-source-row');
      if (!row || !config) return;
      config.sources = config.sources.filter((source) => source.id !== row.dataset.sourceId);
      renderSources();
    });
  });
}

function rowValue(row: HTMLElement, field: string): HTMLInputElement | HTMLSelectElement {
  const input = row.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${field}"]`);
  if (!input) throw new Error(`設定項目 ${field} が見つかりません`);
  return input;
}

function collectSources(): ShoppingSource[] {
  return [...document.querySelectorAll<HTMLElement>('.shopping-source-row')].map((row) => {
    const flatRaw = rowValue(row, 'flatShippingYen').value.trim();
    return {
      id: row.dataset.sourceId || `source-${crypto.randomUUID()}`,
      name: rowValue(row, 'name').value.trim(),
      kind: rowValue(row, 'kind').value as SourceKind,
      pageUrl: rowValue(row, 'pageUrl').value.trim(),
      searchUrlTemplate: rowValue(row, 'searchUrlTemplate').value.trim() || null,
      shippingMode: rowValue(row, 'shippingMode').value as ShippingMode,
      flatShippingYen: flatRaw ? Number(flatRaw) : null,
      enabled: (rowValue(row, 'enabled') as HTMLInputElement).checked,
    };
  });
}

async function loadConfig(): Promise<void> {
  config = await request<ShoppingConfig>('/api/shopping/config');
  const enabled = document.getElementById('shoppingEnabled') as HTMLInputElement | null;
  const hour = document.getElementById('shoppingRefreshHour') as HTMLInputElement | null;
  if (enabled) enabled.checked = config.enabled;
  if (hour) hour.value = String(config.refreshHour);
  renderSources();
}

async function loadDigest(): Promise<void> {
  const response = await request<{ digest: ShoppingDigest | null }>('/api/shopping/deals');
  renderDigest(response.digest);
}

function initialize(): void {
  const element = root();
  if (!element || initialized) return;
  initialized = true;
  element.innerHTML = `<div class="shopping-view foundation-form">
    <header class="shopping-header"><div><h2>🛒 お買い物検索くん</h2><p>いつものチラシ・ネットスーパー・通販セールを、送料込みで比較します。</p></div></header>
    <section class="shopping-panel">
      <h3>商品名から最安を検索</h3>
      <form id="shoppingSearchForm" class="shopping-search-form">
        <input id="shoppingQuery" type="search" maxlength="120" required placeholder="例: 無洗米 5kg">
        <button type="submit">送料込みで比較</button>
      </form>
      <div id="shoppingSearchStatus" class="muted"></div>
      <div id="shoppingResults"></div>
    </section>
    <section class="shopping-panel">
      <div class="shopping-panel-head"><div><h3>今日のお買い得ニュース</h3><p>登録したチラシと Amazon・楽天などのセールを巡回します。</p></div><button id="shoppingRefreshDeals" type="button" class="ghost">今すぐ更新</button></div>
      <div id="shoppingDeals"><div class="empty">読み込み中…</div></div>
    </section>
    <details class="shopping-panel shopping-settings">
      <summary>巡回する店舗と送料の設定</summary>
      <div class="shopping-settings-head">
        <label><span>日次巡回</span><input id="shoppingEnabled" type="checkbox"></label>
        <label><span>毎日の巡回時刻</span><input id="shoppingRefreshHour" type="number" min="0" max="23"></label>
        <button id="shoppingAddSource" type="button" class="ghost">+ 店舗を追加</button>
      </div>
      <p class="shopping-caution">店頭チラシは送料0円、ネット店舗は「ページから読む」を選んでください。送料がページ上で確認できない候補は最安判定から除外します。</p>
      <div id="shoppingSources"></div>
      <div class="shopping-settings-actions"><button id="shoppingSaveConfig" type="button">設定を保存</button><span id="shoppingConfigStatus" class="muted"></span></div>
    </details>
  </div>`;

  document.getElementById('shoppingSearchForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = (document.getElementById('shoppingQuery') as HTMLInputElement).value.trim();
    const status = document.getElementById('shoppingSearchStatus');
    if (status) status.textContent = '各店舗を巡回しています…';
    try {
      const result = await request<ShoppingSearchResult>('/api/shopping/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
      });
      renderSearch(result);
      if (status) status.textContent = `${result.offers.length}件を比較しました`;
    } catch (error) {
      if (status) status.textContent = `検索失敗: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  document.getElementById('shoppingRefreshDeals')?.addEventListener('click', async () => {
    const button = document.getElementById('shoppingRefreshDeals') as HTMLButtonElement;
    button.disabled = true;
    button.textContent = '巡回中…';
    try {
      const response = await request<{ digest: ShoppingDigest }>('/api/shopping/deals/refresh', { method: 'POST' });
      renderDigest(response.digest);
    } catch (error) {
      alert(`お買い得ニュースの更新失敗: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      button.disabled = false;
      button.textContent = '今すぐ更新';
    }
  });

  document.getElementById('shoppingAddSource')?.addEventListener('click', () => {
    if (!config) return;
    config.sources = collectSources();
    config.sources.push({
      id: `source-${crypto.randomUUID()}`, name: '新しい店舗', kind: 'flyer', pageUrl: 'https://',
      searchUrlTemplate: null, shippingMode: 'in_store', flatShippingYen: null, enabled: true,
    });
    renderSources();
  });

  document.getElementById('shoppingSaveConfig')?.addEventListener('click', async () => {
    const status = document.getElementById('shoppingConfigStatus');
    try {
      if (!config) throw new Error('設定が読み込まれていません');
      const next: ShoppingConfig = {
        ...config,
        enabled: (document.getElementById('shoppingEnabled') as HTMLInputElement).checked,
        refreshHour: Number((document.getElementById('shoppingRefreshHour') as HTMLInputElement).value),
        sources: collectSources(),
      };
      config = await request<ShoppingConfig>('/api/shopping/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
      });
      renderSources();
      if (status) status.textContent = '保存しました';
    } catch (error) {
      if (status) status.textContent = `保存失敗: ${error instanceof Error ? error.message : String(error)}`;
    }
  });
}

export async function loadShoppingView(): Promise<void> {
  initialize();
  try {
    await Promise.all([loadConfig(), loadDigest()]);
  } catch (error) {
    const output = document.getElementById('shoppingDeals') ?? root();
    if (output) output.innerHTML = `<div class="empty">お買い物検索くんの読み込みに失敗しました: ${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
  }
}
