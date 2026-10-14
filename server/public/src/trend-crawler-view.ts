// 🤖 AI タブ > 📈 トレンド。
// いろいろなジャンルのランキング・人気一覧を定期巡回して、 ジャンル別に並べる。
// 前回巡回との順位の動き (新登場 / ↑ / ↓)、 複数ソースに出ている話題、 AI のジャンル別要約を表示する。

import { escapeHtml } from './shared/sanitize.js';
import { loadTrendMap } from './trend-map-view.js';

type TrendGenre =
  | 'general' | 'youth' | 'news' | 'tech' | 'game' | 'anime' | 'music'
  | 'app' | 'book' | 'entertainment' | 'life' | 'global';
type SourceKind = 'rss' | 'apple_top' | 'wikipedia_top' | 'anilist_anime' | 'anilist_manga' | 'hn_top';
type MovementStatus = 'new' | 'up' | 'down' | 'same' | 'unknown';

interface TrendSource {
  id: string;
  name: string;
  genre: TrendGenre;
  kind: SourceKind;
  url: string;
  enabled: boolean;
}

interface TrendCrawlerConfig {
  defaultsVersion: number;
  enabled: boolean;
  intervalHours: number;
  itemsPerSource: number;
  retentionDays: number;
  summarize: boolean;
  sources: TrendSource[];
}

interface TrendItemView {
  rank: number;
  title: string;
  subtitle: string | null;
  url: string | null;
  metric: string | null;
  key: string;
  movement: { status: MovementStatus; delta: number | null };
  firstSeenAt: string | null;
}

interface TrendSourceView {
  sourceId: string;
  name: string;
  kind: SourceKind;
  url: string;
  fetchedAt: string | null;
  error: string | null;
  items: TrendItemView[];
}

interface TrendGenreView {
  genre: TrendGenre;
  label: string;
  summary: string | null;
  sources: TrendSourceView[];
}

interface TrendCrossHit {
  key: string;
  title: string;
  sources: { sourceId: string; name: string; genre: TrendGenre; rank: number }[];
}

interface TrendOverview {
  lastCrawledAt: string | null;
  summary: { generatedAt: string; overall: string | null } | null;
  crossHits: TrendCrossHit[];
  genres: TrendGenreView[];
}

interface TrendCrawlResult {
  crawledAt: string;
  ok: number;
  failed: { sourceId: string; error: string }[];
  summaryError: string | null;
}

const GENRE_LABELS: Record<TrendGenre, string> = {
  general: '総合 (検索・閲覧)',
  youth: '若者 (Z世代)',
  news: 'ニュース・社会',
  tech: 'テック',
  game: 'ゲーム',
  anime: 'アニメ・マンガ',
  music: '音楽',
  app: 'アプリ',
  book: '本',
  entertainment: 'エンタメ',
  life: '暮らし・知識',
  global: '海外',
};

const KIND_LABELS: Record<SourceKind, string> = {
  rss: 'RSS / Atom',
  apple_top: 'Apple ランキング',
  wikipedia_top: 'Wikipedia 閲覧数',
  anilist_anime: 'AniList アニメ',
  anilist_manga: 'AniList マンガ',
  hn_top: 'Hacker News',
};

/** 1 ソースのカードで最初に見せる件数 (残りは「もっと見る」)。 */
const VISIBLE_ITEMS = 10;
const NEW_SINCE_MS = 24 * 60 * 60 * 1000;

let initialized = false;
let config: TrendCrawlerConfig | null = null;
let selectedGenre: TrendGenre | 'all' = 'all';
let lastOverview: TrendOverview | null = null;

type DisplayMode = 'map' | 'list';
const MODE_STORAGE_KEY = 'memoria.trendCrawler.mode';

/** 表示の切り替え (マップ / リスト) は端末ごとの好みなので localStorage に置く。 読めなくてもマップで始める。 */
function readMode(): DisplayMode {
  try { return localStorage.getItem(MODE_STORAGE_KEY) === 'list' ? 'list' : 'map'; } catch { return 'map'; }
}

function writeMode(mode: DisplayMode): void {
  try { localStorage.setItem(MODE_STORAGE_KEY, mode); } catch { /* 保存できなくても切り替えは効く */ }
}

let mode: DisplayMode = readMode();

function applyMode(): void {
  document.getElementById('trendCrawlerMap')?.classList.toggle('hidden', mode !== 'map');
  document.getElementById('trendCrawlerOverview')?.classList.toggle('hidden', mode !== 'list');
  document.querySelectorAll<HTMLButtonElement>('.tc-mode [data-mode]').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });
}

async function loadMap(): Promise<void> {
  const container = document.getElementById('trendCrawlerMap');
  if (container) await loadTrendMap(container);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function movementBadge(item: TrendItemView): string {
  const { status, delta } = item.movement;
  if (status === 'new') return '<span class="tc-move tc-move-new" title="前回の巡回には無かった">NEW</span>';
  if (status === 'up') return `<span class="tc-move tc-move-up" title="前回から ${delta} 位上がった">↑${delta}</span>`;
  if (status === 'down') return `<span class="tc-move tc-move-down" title="前回から ${Math.abs(delta ?? 0)} 位下がった">↓${Math.abs(delta ?? 0)}</span>`;
  if (status === 'same') return '<span class="tc-move tc-move-same" title="前回と同じ順位">→</span>';
  return '';
}

function isRecentlyFirstSeen(item: TrendItemView, fetchedAt: string | null): boolean {
  if (!item.firstSeenAt || !fetchedAt) return false;
  return Date.parse(fetchedAt) - Date.parse(item.firstSeenAt) < NEW_SINCE_MS && item.movement.status !== 'unknown';
}

function itemRow(item: TrendItemView, source: TrendSourceView, hidden: boolean): string {
  const title = item.url
    ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>`
    : escapeHtml(item.title);
  const fresh = isRecentlyFirstSeen(item, source.fetchedAt) ? ' tc-item-fresh' : '';
  return `<li class="tc-item${fresh}${hidden ? ' hidden' : ''}" title="${item.firstSeenAt ? `初登場 ${escapeHtml(fmtTime(item.firstSeenAt))}` : ''}">
    <span class="tc-rank">${item.rank}</span>
    <span class="tc-item-body">
      <span class="tc-item-title">${title}</span>
      ${item.subtitle ? `<span class="tc-item-sub">${escapeHtml(item.subtitle)}</span>` : ''}
    </span>
    ${item.metric ? `<span class="tc-metric">${escapeHtml(item.metric)}</span>` : ''}
    ${movementBadge(item)}
  </li>`;
}

function sourceCard(source: TrendSourceView): string {
  const more = source.items.length > VISIBLE_ITEMS
    ? `<button type="button" class="ghost tc-more" data-source-id="${escapeHtml(source.sourceId)}">残り ${source.items.length - VISIBLE_ITEMS} 件を表示</button>`
    : '';
  const items = source.items.length
    ? `<ol class="tc-items">${source.items.map((item, index) => itemRow(item, source, index >= VISIBLE_ITEMS)).join('')}</ol>${more}`
    : '<div class="empty">まだ取得していません</div>';
  return `<article class="tc-source" data-source-id="${escapeHtml(source.sourceId)}">
    <header class="tc-source-head">
      <div>
        <h4>${escapeHtml(source.name)}</h4>
        <p class="tc-source-meta">${escapeHtml(KIND_LABELS[source.kind] ?? source.kind)}${source.fetchedAt ? ` · 取得 ${escapeHtml(fmtTime(source.fetchedAt))}` : ''}</p>
      </div>
      <button type="button" class="ghost tc-refresh-one" data-source-id="${escapeHtml(source.sourceId)}" title="このソースだけ取り直す">↻</button>
    </header>
    ${source.error ? `<div class="tc-error">⚠ 最新の巡回に失敗: ${escapeHtml(source.error)}</div>` : ''}
    ${items}
  </article>`;
}

function genreSection(genre: TrendGenreView): string {
  return `<section class="tc-genre" data-genre="${genre.genre}">
    <h3>${escapeHtml(genre.label)}</h3>
    ${genre.summary ? `<p class="tc-genre-summary">${escapeHtml(genre.summary)}</p>` : ''}
    <div class="tc-source-grid">${genre.sources.map(sourceCard).join('')}</div>
  </section>`;
}

function crossHitsBlock(hits: TrendCrossHit[]): string {
  if (!hits.length) return '';
  return `<section class="tc-cross">
    <h3>複数のソースで話題</h3>
    <ul class="tc-cross-list">${hits.map((hit) => `<li>
      <span class="tc-cross-title">${escapeHtml(hit.title)}</span>
      <span class="tc-cross-sources">${hit.sources.map((s) => `${escapeHtml(s.name)} ${s.rank}位`).join(' · ')}</span>
    </li>`).join('')}</ul>
  </section>`;
}

function genreTabs(overview: TrendOverview): string {
  const tabs = [{ key: 'all', label: 'すべて' }, ...overview.genres.map((g) => ({ key: g.genre, label: GENRE_LABELS[g.genre] ?? g.label }))];
  return `<nav class="tc-genre-tabs">${tabs.map((tab) =>
    `<button type="button" class="wl-subtab${tab.key === selectedGenre ? ' active' : ''}" data-genre="${tab.key}">${escapeHtml(tab.label)}</button>`).join('')}</nav>`;
}

function renderOverview(overview: TrendOverview): void {
  lastOverview = overview;
  const output = document.getElementById('trendCrawlerOverview');
  if (!output) return;
  if (overview.genres.length === 0) {
    output.innerHTML = '<div class="empty">有効なソースがありません。 下の設定でソースを有効にしてください。</div>';
    return;
  }
  if (!overview.genres.some((genre) => genre.genre === selectedGenre)) selectedGenre = 'all';
  const genres = selectedGenre === 'all' ? overview.genres : overview.genres.filter((genre) => genre.genre === selectedGenre);
  const crawled = overview.lastCrawledAt ? `最終巡回 ${escapeHtml(fmtTime(overview.lastCrawledAt))}` : 'まだ巡回していません。「今すぐ巡回」を押すか、 次の自動巡回を待ってください。';
  const overall = selectedGenre === 'all' && overview.summary?.overall
    ? `<div class="tc-overall"><strong>いまの流れ</strong><p>${escapeHtml(overview.summary.overall)}</p><span class="muted">AI 要約 ${escapeHtml(fmtTime(overview.summary.generatedAt))}</span></div>`
    : '';
  output.innerHTML = `<p class="tc-crawled muted">${crawled}</p>
    ${genreTabs(overview)}
    ${overall}
    ${selectedGenre === 'all' ? crossHitsBlock(overview.crossHits) : ''}
    ${genres.map(genreSection).join('')}`;
  output.querySelectorAll<HTMLButtonElement>('.tc-genre-tabs [data-genre]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedGenre = button.dataset.genre as TrendGenre | 'all';
      if (lastOverview) renderOverview(lastOverview);
    });
  });
  output.querySelectorAll<HTMLButtonElement>('.tc-refresh-one').forEach((button) => {
    button.addEventListener('click', () => { void refresh(button.dataset.sourceId); });
  });
  output.querySelectorAll<HTMLButtonElement>('.tc-more').forEach((button) => {
    button.addEventListener('click', () => {
      button.closest('.tc-source')?.querySelectorAll('.tc-item.hidden').forEach((item) => item.classList.remove('hidden'));
      button.remove();
    });
  });
}

function setStatus(text: string): void {
  const status = document.getElementById('trendCrawlerStatus');
  if (status) status.textContent = text;
}

function describeResult(result: TrendCrawlResult): string {
  const parts = [`${result.ok} ソースを取得`];
  if (result.failed.length) parts.push(`${result.failed.length} ソースは失敗`);
  if (result.summaryError) parts.push(`AI 要約は失敗 (${result.summaryError})`);
  return parts.join(' · ');
}

async function refresh(sourceId?: string): Promise<void> {
  const button = document.getElementById('trendCrawlerRefresh') as HTMLButtonElement | null;
  if (button) { button.disabled = true; button.textContent = '巡回中…'; }
  setStatus(sourceId ? 'このソースを取り直しています…' : '全ソースを巡回して AI でまとめています (1〜2 分かかることがあります)…');
  try {
    const query = sourceId ? `?source=${encodeURIComponent(sourceId)}` : '';
    const response = await request<{ result: TrendCrawlResult; overview: TrendOverview }>(`/api/trend-crawler/refresh${query}`, { method: 'POST' });
    renderOverview(response.overview);
    await loadMap();
    setStatus(describeResult(response.result));
  } catch (error) {
    setStatus(`巡回失敗: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (button) { button.disabled = false; button.textContent = '今すぐ巡回'; }
  }
}

// ── 設定 ──────────────────────────────────────────────────────────────

function sourceRow(source: TrendSource): string {
  const genreOptions = (Object.keys(GENRE_LABELS) as TrendGenre[])
    .map((g) => `<option value="${g}"${g === source.genre ? ' selected' : ''}>${escapeHtml(GENRE_LABELS[g])}</option>`).join('');
  const kindOptions = (Object.keys(KIND_LABELS) as SourceKind[])
    .map((k) => `<option value="${k}"${k === source.kind ? ' selected' : ''}>${escapeHtml(KIND_LABELS[k])}</option>`).join('');
  return `<div class="tc-source-row" data-source-id="${escapeHtml(source.id)}">
    <label><span>名前</span><input data-field="name" type="text" maxlength="80" value="${escapeHtml(source.name)}"></label>
    <label><span>ジャンル</span><select data-field="genre">${genreOptions}</select></label>
    <label><span>種類</span><select data-field="kind">${kindOptions}</select></label>
    <label><span>有効</span><input data-field="enabled" type="checkbox"${source.enabled ? ' checked' : ''}></label>
    <label class="tc-source-wide"><span>URL</span><input data-field="url" type="url" value="${escapeHtml(source.url)}"></label>
    <button type="button" class="ghost tc-source-remove">削除</button>
  </div>`;
}

function rowValue(row: HTMLElement, field: string): HTMLInputElement | HTMLSelectElement {
  return row.querySelector(`[data-field="${field}"]`) as HTMLInputElement | HTMLSelectElement;
}

function collectSources(): TrendSource[] {
  return [...document.querySelectorAll<HTMLElement>('.tc-source-row')].map((row) => ({
    id: row.dataset.sourceId || `source-${crypto.randomUUID()}`,
    name: rowValue(row, 'name').value.trim(),
    genre: rowValue(row, 'genre').value as TrendGenre,
    kind: rowValue(row, 'kind').value as SourceKind,
    url: rowValue(row, 'url').value.trim(),
    enabled: (rowValue(row, 'enabled') as HTMLInputElement).checked,
  }));
}

/** サーバの zod スキーマで弾かれる行を、 保存前に日本語で説明する (問題なければ null)。 */
function describeSourceProblem(source: TrendSource): string | null {
  const where = `「${source.name || '(名前なし)'}」`;
  if (!source.name) return `${where}: 名前を入力してください`;
  let url: URL;
  try { url = new URL(source.url); } catch { return `${where}: URL が不正です`; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${where}: http(s) の URL を指定してください`;
  if (source.kind === 'apple_top' && !/^rss\.(marketingtools\.apple|applemarketingtools)\.com$/.test(url.hostname)) {
    return `${where}: Apple ランキングは rss.marketingtools.apple.com の URL が必要です`;
  }
  if (source.kind === 'wikipedia_top' && !/^[a-z-]+\.wikipedia\.org$/.test(url.hostname)) {
    return `${where}: Wikipedia は https://ja.wikipedia.org のような URL が必要です`;
  }
  return null;
}

function numberField(id: string, label: string, min: number, max: number): number {
  const value = Number((document.getElementById(id) as HTMLInputElement).value);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label}は ${min}〜${max} の整数で入力してください`);
  }
  return value;
}

function renderSources(): void {
  const list = document.getElementById('trendCrawlerSources');
  if (!list || !config) return;
  list.innerHTML = config.sources.map(sourceRow).join('');
  list.querySelectorAll<HTMLButtonElement>('.tc-source-remove').forEach((button) => {
    button.addEventListener('click', () => {
      const row = button.closest<HTMLElement>('.tc-source-row');
      if (!row || !config) return;
      config.sources = collectSources().filter((s) => s.id !== row.dataset.sourceId);
      renderSources();
    });
  });
}

async function loadConfig(): Promise<void> {
  config = await request<TrendCrawlerConfig>('/api/trend-crawler/config');
  (document.getElementById('trendCrawlerEnabled') as HTMLInputElement).checked = config.enabled;
  (document.getElementById('trendCrawlerSummarize') as HTMLInputElement).checked = config.summarize;
  (document.getElementById('trendCrawlerInterval') as HTMLInputElement).value = String(config.intervalHours);
  (document.getElementById('trendCrawlerItems') as HTMLInputElement).value = String(config.itemsPerSource);
  (document.getElementById('trendCrawlerRetention') as HTMLInputElement).value = String(config.retentionDays);
  renderSources();
}

async function loadOverview(): Promise<void> {
  const response = await request<{ overview: TrendOverview; busy: boolean }>('/api/trend-crawler/overview');
  renderOverview(response.overview);
  setStatus(response.busy ? '巡回中…' : '');
}

async function saveConfig(): Promise<void> {
  const status = document.getElementById('trendCrawlerConfigStatus');
  try {
    if (!config) throw new Error('設定が読み込まれていません');
    const sources = collectSources();
    const invalid = sources.map(describeSourceProblem).find(Boolean);
    if (invalid) throw new Error(invalid);
    const next: TrendCrawlerConfig = {
      ...config,
      enabled: (document.getElementById('trendCrawlerEnabled') as HTMLInputElement).checked,
      summarize: (document.getElementById('trendCrawlerSummarize') as HTMLInputElement).checked,
      intervalHours: numberField('trendCrawlerInterval', '巡回間隔', 1, 24),
      itemsPerSource: numberField('trendCrawlerItems', '1 ソースの件数', 1, 50),
      retentionDays: numberField('trendCrawlerRetention', '履歴の保持日数', 1, 365),
      sources,
    };
    config = await request<TrendCrawlerConfig>('/api/trend-crawler/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
    });
    renderSources();
    if (status) status.textContent = '保存しました';
    await Promise.all([loadOverview(), loadMap()]);
  } catch (error) {
    if (status) status.textContent = `保存失敗: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function initialize(): void {
  const element = document.getElementById('trendCrawlerRoot');
  if (!element || initialized) return;
  initialized = true;
  element.innerHTML = `<div class="tc-view foundation-form">
    <header class="tc-header">
      <div><h2>📈 トレンド</h2><p>検索・ニュース・テック・ゲーム・アニメ・音楽・アプリ・本などのランキングを定期的に巡回し、 前回からの順位の動きと AI の要約をジャンル別に並べます。</p></div>
      <div class="tc-header-actions"><button id="trendCrawlerRefresh" type="button">今すぐ巡回</button><span id="trendCrawlerStatus" class="muted"></span></div>
    </header>
    <nav class="tc-mode worklog-subtabs"><button type="button" class="wl-subtab" data-mode="map">🫧 マップ</button><button type="button" class="wl-subtab" data-mode="list">☰ リスト</button></nav>
    <div id="trendCrawlerMap"><div class="empty">読み込み中…</div></div>
    <div id="trendCrawlerOverview"><div class="empty">読み込み中…</div></div>
    <details class="tc-settings">
      <summary>巡回するソースの設定</summary>
      <div class="tc-settings-head">
        <label><span>自動で巡回</span><input id="trendCrawlerEnabled" type="checkbox"></label>
        <label><span>AI で要約</span><input id="trendCrawlerSummarize" type="checkbox"></label>
        <label><span>巡回間隔 (時間)</span><input id="trendCrawlerInterval" type="number" min="1" max="24"></label>
        <label><span>1 ソースの件数</span><input id="trendCrawlerItems" type="number" min="1" max="50"></label>
        <label><span>履歴の保持日数</span><input id="trendCrawlerRetention" type="number" min="1" max="365"></label>
        <button id="trendCrawlerAddSource" type="button" class="ghost">+ ソースを追加</button>
      </div>
      <p class="tc-caution">RSS / Atom ならどのサイトでも追加できます (並び順を順位として扱います)。 Apple ランキングは URL の国コード・種類・件数を変えると別のランキングになります。</p>
      <div id="trendCrawlerSources"></div>
      <div class="tc-settings-actions"><button id="trendCrawlerSaveConfig" type="button">設定を保存</button><span id="trendCrawlerConfigStatus" class="muted"></span></div>
    </details>
  </div>`;

  document.getElementById('trendCrawlerRefresh')?.addEventListener('click', () => { void refresh(); });
  element.querySelectorAll<HTMLButtonElement>('.tc-mode [data-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      mode = button.dataset.mode === 'list' ? 'list' : 'map';
      writeMode(mode);
      applyMode();
    });
  });
  applyMode();
  document.getElementById('trendCrawlerAddSource')?.addEventListener('click', () => {
    if (!config) return;
    config.sources = collectSources();
    config.sources.push({
      id: `source-${crypto.randomUUID()}`, name: '新しいソース', genre: 'general', kind: 'rss', url: 'https://example.com/feed.xml', enabled: true,
    });
    renderSources();
  });
  document.getElementById('trendCrawlerSaveConfig')?.addEventListener('click', () => { void saveConfig(); });
}

export async function loadTrendCrawlerView(): Promise<void> {
  initialize();
  try {
    await Promise.all([loadConfig(), loadOverview(), loadMap()]);
  } catch (error) {
    const output = document.getElementById('trendCrawlerOverview');
    if (output) output.innerHTML = `<div class="empty">読み込み失敗: ${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
  }
}
