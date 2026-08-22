// 🤖 AI タブ > 🔄 更新クローラー。
// 登録した公式サイト (Claude Code / Codex / Unity / UE / Git …) の更新履歴を
// 日次で巡回し、 直近 N バージョンの日本語要約をソース別カードで表示する。

import { renderMarkdownBlock } from './markdown-block.js';
import { escapeHtml } from './notes/sanitize.js';

type SourceKind = 'github_releases' | 'github_tags' | 'rss' | 'html';

interface ReleaseSource {
  id: string;
  name: string;
  kind: SourceKind;
  url: string;
  notesUrlTemplate: string | null;
  includePattern: string | null;
  enabled: boolean;
}

interface ReleaseWatchConfig {
  defaultsVersion: number;
  enabled: boolean;
  refreshHour: number;
  versionsPerSource: number;
  sources: ReleaseSource[];
}

interface ReleaseEntry {
  version: string;
  url: string;
  publishedAt: string | null;
  summaryJa: string;
  summarizedAt: string;
}

interface ReleaseSourceDigest {
  sourceId: string;
  sourceName: string;
  sourceKind: SourceKind;
  url: string;
  entries: ReleaseEntry[];
  fetchedAt: string;
  error: string | null;
}

interface ReleaseDigest {
  /** 全ソースを巡回し切った日。 1 ソースのみの更新では進まないため null がありうる。 */
  date: string | null;
  generatedAt: string;
  sources: ReleaseSourceDigest[];
}

const KIND_LABELS: Record<SourceKind, string> = {
  github_releases: 'GitHub Releases',
  github_tags: 'GitHub タグ + リリースノート',
  rss: 'RSS / Atom',
  html: '公式ページ (AI 抽出)',
};

let initialized = false;
let config: ReleaseWatchConfig | null = null;

function root(): HTMLElement | null {
  return document.getElementById('releaseWatchRoot');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Date(time).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function entryCard(entry: ReleaseEntry, latest: boolean): string {
  const date = fmtDate(entry.publishedAt);
  return `<li class="rw-entry${latest ? ' rw-entry-latest' : ''}">
    <div class="rw-entry-head">
      <a class="rw-entry-version" href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.version)}</a>
      ${latest ? '<span class="rw-badge">最新</span>' : ''}
      ${date ? `<span class="rw-entry-date">${escapeHtml(date)}</span>` : ''}
    </div>
    <div class="rw-entry-summary">${renderMarkdownBlock(entry.summaryJa)}</div>
  </li>`;
}

function sourceCard(source: ReleaseSourceDigest): string {
  const entries = source.entries.length
    ? `<ol class="rw-entries">${source.entries.map((e, i) => entryCard(e, i === 0)).join('')}</ol>`
    : '<div class="empty">まだ取得していません</div>';
  return `<article class="rw-source" data-source-id="${escapeHtml(source.sourceId)}">
    <header class="rw-source-head">
      <div>
        <h3><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.sourceName)}</a></h3>
        <p class="rw-source-meta">${escapeHtml(KIND_LABELS[source.sourceKind] ?? source.sourceKind)} · 取得 ${escapeHtml(new Date(source.fetchedAt).toLocaleString('ja-JP'))}</p>
      </div>
      <button type="button" class="ghost rw-refresh-one" data-source-id="${escapeHtml(source.sourceId)}">このサイトだけ更新</button>
    </header>
    ${source.error ? `<div class="rw-error">⚠ ${escapeHtml(source.error)}</div>` : ''}
    ${entries}
  </article>`;
}

function renderDigest(digest: ReleaseDigest | null): void {
  const output = document.getElementById('releaseWatchDigest');
  if (!output) return;
  if (!digest || digest.sources.length === 0) {
    output.innerHTML = '<div class="empty">まだ巡回していません。「今すぐ巡回」を押すか、毎日の巡回時刻を待ってください。</div>';
    return;
  }
  const scope = digest.date ? `${escapeHtml(digest.date)} の巡回結果` : '個別更新のみ (全体の巡回は未完)';
  output.innerHTML = `<p class="rw-digest-date">${scope} · ${escapeHtml(new Date(digest.generatedAt).toLocaleString('ja-JP'))}</p>
    <div class="rw-source-grid">${digest.sources.map(sourceCard).join('')}</div>`;
  output.querySelectorAll<HTMLButtonElement>('.rw-refresh-one').forEach((button) => {
    button.addEventListener('click', () => { void refresh(button.dataset.sourceId); });
  });
}

function sourceRow(source: ReleaseSource): string {
  const kindOptions = (Object.keys(KIND_LABELS) as SourceKind[])
    .map((k) => `<option value="${k}"${k === source.kind ? ' selected' : ''}>${escapeHtml(KIND_LABELS[k])}</option>`).join('');
  return `<div class="rw-source-row" data-source-id="${escapeHtml(source.id)}">
    <label><span>名前</span><input data-field="name" type="text" maxlength="80" value="${escapeHtml(source.name)}"></label>
    <label><span>種類</span><select data-field="kind">${kindOptions}</select></label>
    <label><span>有効</span><input data-field="enabled" type="checkbox"${source.enabled ? ' checked' : ''}></label>
    <label class="rw-source-wide"><span>URL（GitHub はリポジトリ URL、RSS は feed URL、公式ページは更新履歴ページ）</span><input data-field="url" type="url" value="${escapeHtml(source.url)}"></label>
    <label class="rw-source-wide"><span>リリースノート URL テンプレ（タグ種類のみ。{tag} / {version} を置換）</span><input data-field="notesUrlTemplate" type="text" value="${escapeHtml(source.notesUrlTemplate ?? '')}" placeholder="https://raw.githubusercontent.com/owner/repo/{tag}/CHANGELOG.md"></label>
    <label class="rw-source-wide"><span>対象バージョンの絞り込み（正規表現、空で全件。例: ^v\\d+\\.\\d+\\.\\d+$ で rc/alpha を除外）</span><input data-field="includePattern" type="text" value="${escapeHtml(source.includePattern ?? '')}"></label>
    <button type="button" class="ghost rw-source-remove">削除</button>
  </div>`;
}

function rowValue(row: HTMLElement, field: string): HTMLInputElement | HTMLSelectElement {
  return row.querySelector(`[data-field="${field}"]`) as HTMLInputElement | HTMLSelectElement;
}

function collectSources(): ReleaseSource[] {
  return [...document.querySelectorAll<HTMLElement>('.rw-source-row')].map((row) => ({
    id: row.dataset.sourceId || `source-${crypto.randomUUID()}`,
    name: rowValue(row, 'name').value.trim(),
    kind: rowValue(row, 'kind').value as SourceKind,
    url: rowValue(row, 'url').value.trim(),
    notesUrlTemplate: rowValue(row, 'notesUrlTemplate').value.trim() || null,
    includePattern: rowValue(row, 'includePattern').value.trim() || null,
    enabled: (rowValue(row, 'enabled') as HTMLInputElement).checked,
  }));
}

/** サーバの zod スキーマで弾かれる行を、 保存前に日本語で説明する (問題なければ null)。 */
function describeSourceProblem(source: ReleaseSource): string | null {
  const where = `「${source.name || '(名前なし)'}」`;
  if (!source.name) return `${where}: 名前を入力してください`;
  let url: URL;
  try { url = new URL(source.url); } catch { return `${where}: URL が不正です`; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${where}: http(s) の URL を指定してください`;
  if (source.kind === 'github_releases' || source.kind === 'github_tags') {
    if (!/^github\.com$/.test(url.hostname) || !/^\/[^/]+\/[^/]+\/?$/.test(url.pathname)) {
      return `${where}: GitHub の種類では https://github.com/<owner>/<repo> 形式の URL が必要です`;
    }
  }
  if (source.includePattern !== null) {
    try { new RegExp(source.includePattern); } catch { return `${where}: 絞り込みの正規表現が不正です`; }
  }
  if (source.notesUrlTemplate !== null) {
    try { new URL(source.notesUrlTemplate); } catch { return `${where}: リリースノート URL テンプレが不正です`; }
  }
  return null;
}

/** 空欄の number input は `Number('')` = NaN になり、 サーバに弾かれるので手前で止める。 */
function numberField(id: string, label: string, min: number, max: number): number {
  const value = Number((document.getElementById(id) as HTMLInputElement).value);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label}は ${min}〜${max} の整数で入力してください`);
  }
  return value;
}

function renderSources(): void {
  const list = document.getElementById('releaseWatchSources');
  if (!list || !config) return;
  list.innerHTML = config.sources.map(sourceRow).join('');
  list.querySelectorAll<HTMLButtonElement>('.rw-source-remove').forEach((button) => {
    button.addEventListener('click', () => {
      const row = button.closest<HTMLElement>('.rw-source-row');
      if (!row || !config) return;
      config.sources = collectSources().filter((s) => s.id !== row.dataset.sourceId);
      renderSources();
    });
  });
}

async function loadConfig(): Promise<void> {
  config = await request<ReleaseWatchConfig>('/api/release-watch/config');
  (document.getElementById('releaseWatchEnabled') as HTMLInputElement).checked = config.enabled;
  (document.getElementById('releaseWatchHour') as HTMLInputElement).value = String(config.refreshHour);
  (document.getElementById('releaseWatchVersions') as HTMLInputElement).value = String(config.versionsPerSource);
  renderSources();
}

async function loadDigest(): Promise<void> {
  const response = await request<{ digest: ReleaseDigest | null; busy: boolean }>('/api/release-watch/digest');
  renderDigest(response.digest);
  setStatus(response.busy ? '巡回中…' : '');
}

function setStatus(text: string): void {
  const status = document.getElementById('releaseWatchStatus');
  if (status) status.textContent = text;
}

async function refresh(sourceId?: string): Promise<void> {
  const button = document.getElementById('releaseWatchRefresh') as HTMLButtonElement | null;
  if (button) { button.disabled = true; button.textContent = '巡回中…'; }
  setStatus(sourceId ? `${sourceId} を巡回しています…` : '登録サイトを巡回して要約しています (数分かかることがあります)…');
  try {
    const query = sourceId ? `?source=${encodeURIComponent(sourceId)}` : '';
    const response = await request<{ digest: ReleaseDigest }>(`/api/release-watch/refresh${query}`, { method: 'POST' });
    renderDigest(response.digest);
    setStatus('更新しました');
  } catch (error) {
    setStatus(`更新失敗: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (button) { button.disabled = false; button.textContent = '今すぐ巡回'; }
  }
}

function initialize(): void {
  const element = root();
  if (!element || initialized) return;
  initialized = true;
  element.innerHTML = `<div class="rw-view foundation-form">
    <header class="rw-header">
      <div><h2>🔄 更新クローラー</h2><p>Codex・Claude Code・Unity・Unreal Engine・Git などの公式更新履歴を毎日巡回し、直近のバージョンを日本語で要約します。</p></div>
      <div class="rw-header-actions"><button id="releaseWatchRefresh" type="button">今すぐ巡回</button><span id="releaseWatchStatus" class="muted"></span></div>
    </header>
    <div id="releaseWatchDigest"><div class="empty">読み込み中…</div></div>
    <details class="rw-settings">
      <summary>監視するサイトの設定</summary>
      <div class="rw-settings-head">
        <label><span>毎日巡回</span><input id="releaseWatchEnabled" type="checkbox"></label>
        <label><span>巡回時刻</span><input id="releaseWatchHour" type="number" min="0" max="23"></label>
        <label><span>表示するバージョン数</span><input id="releaseWatchVersions" type="number" min="1" max="10"></label>
        <button id="releaseWatchAddSource" type="button" class="ghost">+ サイトを追加</button>
      </div>
      <p class="rw-caution">GitHub Releases / RSS が最も安定します。RSS も API も無い公式ページは本文を AI に渡してバージョンを抽出しますが、JavaScript 描画ページでは本文が取れず失敗として表示されます。</p>
      <div id="releaseWatchSources"></div>
      <div class="rw-settings-actions"><button id="releaseWatchSaveConfig" type="button">設定を保存</button><span id="releaseWatchConfigStatus" class="muted"></span></div>
    </details>
  </div>`;

  document.getElementById('releaseWatchRefresh')?.addEventListener('click', () => { void refresh(); });

  document.getElementById('releaseWatchAddSource')?.addEventListener('click', () => {
    if (!config) return;
    config.sources = collectSources();
    config.sources.push({
      // URL は保存前に差し替えてもらう前提だが、 既定値のままでもスキーマを通る形にしておく
      // (通らない既定値だと、 追加直後の保存が他の行の編集ごと 400 で落ちる)。
      id: `source-${crypto.randomUUID()}`, name: '新しいサイト', kind: 'github_releases', url: 'https://github.com/owner/repo',
      notesUrlTemplate: null, includePattern: null, enabled: true,
    });
    renderSources();
  });

  document.getElementById('releaseWatchSaveConfig')?.addEventListener('click', async () => {
    const status = document.getElementById('releaseWatchConfigStatus');
    try {
      if (!config) throw new Error('設定が読み込まれていません');
      const sources = collectSources();
      // PUT は全ソースをまとめて送るので、 1 行でも不正だと他の行の編集ごと 400 で捨てられる。
      // どの行が悪いかを先に日本語で示す。
      const invalid = sources.map(describeSourceProblem).find(Boolean);
      if (invalid) throw new Error(invalid);
      const next: ReleaseWatchConfig = {
        ...config,
        enabled: (document.getElementById('releaseWatchEnabled') as HTMLInputElement).checked,
        refreshHour: numberField('releaseWatchHour', '巡回時刻', 0, 23),
        versionsPerSource: numberField('releaseWatchVersions', '表示するバージョン数', 1, 10),
        sources,
      };
      config = await request<ReleaseWatchConfig>('/api/release-watch/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
      });
      renderSources();
      if (status) status.textContent = '保存しました';
    } catch (error) {
      if (status) status.textContent = `保存失敗: ${error instanceof Error ? error.message : String(error)}`;
    }
  });
}

export async function loadReleaseWatchView(): Promise<void> {
  initialize();
  try {
    await Promise.all([loadConfig(), loadDigest()]);
  } catch (error) {
    const output = document.getElementById('releaseWatchDigest');
    if (output) output.innerHTML = `<div class="empty">読み込み失敗: ${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
  }
}
