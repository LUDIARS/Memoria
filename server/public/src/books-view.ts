// 📚 本タブ。 良かった本のリスト / 新刊 / サジェスト / 読破記録の取り込み。
//
// 表示は 3 セクション + 設定。 サーバの /api/books/* を叩くだけで、
// 判断ロジック (スコア・重複排除) はすべてサーバ側に置く。

import { escapeHtml } from './notes/sanitize.js';

interface Book {
  id: number;
  isbn13: string | null;
  title: string;
  authors: string[];
  publisher: string | null;
  publishedOn: string | null;
  rating: number | null;
  review: string | null;
  tags: string[];
  readOn: string | null;
  coverUrl: string | null;
}

interface NewRelease {
  id: number;
  watchKind: 'author' | 'series';
  watchValue: string;
  title: string;
  authors: string[];
  publishedOn: string | null;
  url: string | null;
  coverUrl: string | null;
}

interface Suggestion {
  id: number;
  title: string;
  authors: string[];
  url: string | null;
  coverUrl: string | null;
  origin: 'llm' | 'rakuten_ranking' | 'google_rating';
  reason: string;
  rating: number | null;
}

interface WatchTarget {
  kind: 'author' | 'series';
  value: string;
  bookCount: number;
}

interface BooksConfig {
  defaultsVersion: number;
  enabled: boolean;
  weeklyDay: number;
  weeklyHour: number;
  watchMinRating: number;
  maxWatchTargets: number;
  newReleaseLookbackDays: number;
  newReleaseLookaheadDays: number;
  suggestionCount: number;
  rakutenApplicationId: string;
  sources: { googleBooks: boolean; openbd: boolean; ndl: boolean; rakuten: boolean };
}

const ORIGIN_LABELS: Record<Suggestion['origin'], string> = {
  llm: 'AI 推薦',
  rakuten_ranking: '楽天 売れ筋',
  google_rating: 'Google 高評価',
};

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

let initialized = false;
let config: BooksConfig | null = null;

function root(): HTMLElement | null {
  return document.getElementById('booksRoot');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function postJson<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    return isHttp && !parsed.username && !parsed.password ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function cover(url: string | null, title: string): string {
  const safeUrl = safeHttpUrl(url);
  if (!safeUrl) return '<div class="bk-cover bk-cover-empty">📕</div>';
  return `<img class="bk-cover" src="${escapeHtml(safeUrl)}" alt="${escapeHtml(title)}" loading="lazy">`;
}

function stars(rating: number | null): string {
  if (!rating) return '<span class="muted">未評価</span>';
  return `<span class="bk-stars" title="★${rating}">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}</span>`;
}

function authorsText(authors: string[]): string {
  return authors.length > 0 ? escapeHtml(authors.join(', ')) : '<span class="muted">著者不明</span>';
}

function bookCard(book: Book): string {
  const meta = [book.publisher, book.publishedOn].filter(Boolean).map(String);
  const tags = book.tags.map((tag) => `<span class="bk-tag">${escapeHtml(tag)}</span>`).join('');
  return `<li class="bk-card" data-book-id="${book.id}">
    ${cover(book.coverUrl, book.title)}
    <div class="bk-body">
      <div class="bk-title">${escapeHtml(book.title)}</div>
      <div class="bk-authors">${authorsText(book.authors)}</div>
      <div class="bk-meta">${stars(book.rating)}${meta.length ? ` · ${escapeHtml(meta.join(' / '))}` : ''}${book.readOn ? ` · ${escapeHtml(book.readOn)} 読了` : ''}</div>
      ${book.review ? `<p class="bk-review">${escapeHtml(book.review)}</p>` : ''}
      <div class="bk-tags">${tags}</div>
    </div>
    <div class="bk-actions">
      <label class="bk-rate"><span>評価</span>
        <select class="bk-rate-select" data-book-id="${book.id}">
          ${[0, 1, 2, 3, 4, 5].map((value) => `<option value="${value}"${(book.rating ?? 0) === value ? ' selected' : ''}>${value === 0 ? '—' : `★${value}`}</option>`).join('')}
        </select>
      </label>
      <button type="button" class="ghost bk-delete" data-book-id="${book.id}">削除</button>
    </div>
  </li>`;
}

function newReleaseCard(release: NewRelease): string {
  const safeUrl = safeHttpUrl(release.url);
  const link = safeUrl
    ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">詳細</a>`
    : '';
  return `<li class="bk-card" data-release-id="${release.id}">
    ${cover(release.coverUrl, release.title)}
    <div class="bk-body">
      <div class="bk-title">${escapeHtml(release.title)}</div>
      <div class="bk-authors">${authorsText(release.authors)}</div>
      <div class="bk-meta">${release.publishedOn ? `${escapeHtml(release.publishedOn)} 発売 · ` : ''}${escapeHtml(release.watchValue)} の新刊 ${link}</div>
    </div>
    <div class="bk-actions">
      <button type="button" class="ghost bk-dismiss-release" data-release-id="${release.id}">既読にする</button>
    </div>
  </li>`;
}

function suggestionCard(suggestion: Suggestion): string {
  const safeUrl = safeHttpUrl(suggestion.url);
  const link = safeUrl
    ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">詳細</a>`
    : '';
  return `<li class="bk-card" data-suggestion-id="${suggestion.id}">
    ${cover(suggestion.coverUrl, suggestion.title)}
    <div class="bk-body">
      <div class="bk-title">${escapeHtml(suggestion.title)}</div>
      <div class="bk-authors">${authorsText(suggestion.authors)}</div>
      <div class="bk-meta"><span class="bk-origin">${ORIGIN_LABELS[suggestion.origin]}</span>${suggestion.rating ? ` ★${suggestion.rating.toFixed(1)}` : ''} ${link}</div>
      <p class="bk-review">${escapeHtml(suggestion.reason)}</p>
    </div>
    <div class="bk-actions">
      <button type="button" class="ghost bk-dismiss-suggestion" data-suggestion-id="${suggestion.id}">興味なし</button>
    </div>
  </li>`;
}

function setStatus(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

async function loadShelf(): Promise<void> {
  const query = (document.getElementById('booksSearch') as HTMLInputElement | null)?.value.trim() ?? '';
  const favoritesOnly = (document.getElementById('booksFavoritesOnly') as HTMLInputElement | null)?.checked ?? true;
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (favoritesOnly && config) params.set('minRating', String(config.watchMinRating));
  const body = await request<{ books: Book[]; counts: { total: number; favorites: number } }>(
    `/api/books?${params.toString()}`,
  );
  const list = document.getElementById('booksList');
  if (list) {
    list.innerHTML = body.books.length > 0
      ? body.books.map(bookCard).join('')
      : '<li class="empty">まだ登録がありません。 上のフォームか Discord の /book で登録してください。</li>';
  }
  setStatus('booksCounts', `蔵書 ${body.counts.total} 冊 / お気に入り ${body.counts.favorites} 冊`);
}

async function loadNewReleases(): Promise<void> {
  const body = await request<{ newReleases: NewRelease[]; watchTargets: WatchTarget[] }>('/api/books/new-releases');
  const list = document.getElementById('booksNewReleases');
  if (list) {
    list.innerHTML = body.newReleases.length > 0
      ? body.newReleases.map(newReleaseCard).join('')
      : '<li class="empty">新刊はまだありません。</li>';
  }
  const targets = body.watchTargets
    .map((target) => `<span class="bk-tag">${escapeHtml(target.value)}${target.bookCount > 1 ? ` ×${target.bookCount}` : ''}</span>`)
    .join('');
  const holder = document.getElementById('booksWatchTargets');
  if (holder) {
    holder.innerHTML = targets || '<span class="muted">★評価を付けた本の著者・シリーズが自動でウォッチ対象になります。</span>';
  }
}

async function loadSuggestions(): Promise<void> {
  const body = await request<{ suggestions: Suggestion[] }>('/api/books/suggestions');
  const list = document.getElementById('booksSuggestions');
  if (list) {
    list.innerHTML = body.suggestions.length > 0
      ? body.suggestions.map(suggestionCard).join('')
      : '<li class="empty">「サジェストを作る」を押すと候補を生成します。</li>';
  }
}

async function loadConfig(): Promise<void> {
  config = await request<BooksConfig>('/api/books/config');
  const set = (id: string, value: string | boolean): void => {
    const element = document.getElementById(id) as HTMLInputElement | null;
    if (!element) return;
    if (typeof value === 'boolean') element.checked = value;
    else element.value = value;
  };
  set('booksEnabled', config.enabled);
  set('booksWeeklyDay', String(config.weeklyDay));
  set('booksWeeklyHour', String(config.weeklyHour));
  set('booksMinRating', String(config.watchMinRating));
  set('booksSuggestionCount', String(config.suggestionCount));
  set('booksRakutenId', config.rakutenApplicationId);
  set('booksSourceGoogle', config.sources.googleBooks);
  set('booksSourceOpenbd', config.sources.openbd);
  set('booksSourceNdl', config.sources.ndl);
  set('booksSourceRakuten', config.sources.rakuten);
  const state = await request<{ state: { lastImportedOn: string | null; lastImportedCount: number } }>(
    '/api/books/import/state',
  );
  setStatus('booksImportState', state.state.lastImportedOn
    ? `前回の取り込み: ${state.state.lastImportedOn} (${state.state.lastImportedCount} 件)`
    : 'まだ取り込んでいません');
}

function numberField(id: string, fallback: number): number {
  const value = Number((document.getElementById(id) as HTMLInputElement | null)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function checkboxField(id: string, fallback: boolean): boolean {
  return (document.getElementById(id) as HTMLInputElement | null)?.checked ?? fallback;
}

async function saveConfig(): Promise<void> {
  if (!config) return;
  const next: BooksConfig = {
    ...config,
    enabled: checkboxField('booksEnabled', config.enabled),
    weeklyDay: numberField('booksWeeklyDay', config.weeklyDay),
    weeklyHour: numberField('booksWeeklyHour', config.weeklyHour),
    watchMinRating: numberField('booksMinRating', config.watchMinRating),
    suggestionCount: numberField('booksSuggestionCount', config.suggestionCount),
    rakutenApplicationId: (document.getElementById('booksRakutenId') as HTMLInputElement | null)?.value ?? '',
    sources: {
      googleBooks: checkboxField('booksSourceGoogle', config.sources.googleBooks),
      openbd: checkboxField('booksSourceOpenbd', config.sources.openbd),
      ndl: checkboxField('booksSourceNdl', config.sources.ndl),
      rakuten: checkboxField('booksSourceRakuten', config.sources.rakuten),
    },
  };
  config = await request<BooksConfig>('/api/books/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
  });
  setStatus('booksConfigStatus', '保存しました');
}

async function addBook(): Promise<void> {
  const titleInput = document.getElementById('booksAddTitle') as HTMLInputElement | null;
  const title = titleInput?.value.trim() ?? '';
  if (!title) { setStatus('booksAddStatus', 'タイトルを入力してください'); return; }
  const author = (document.getElementById('booksAddAuthor') as HTMLInputElement | null)?.value.trim() ?? '';
  const ratingValue = Number((document.getElementById('booksAddRating') as HTMLSelectElement | null)?.value ?? '0');
  const review = (document.getElementById('booksAddReview') as HTMLTextAreaElement | null)?.value.trim() ?? '';

  setStatus('booksAddStatus', '書誌を照会中…');
  // 書影・出版社・ISBN はサーバの lookup で補う。 見つからなければ入力値のまま登録する。
  let found: { title: string; authors: string[]; isbn13: string | null; publisher: string | null;
    publishedOn: string | null; coverUrl: string | null } | null = null;
  let lookupWarning: string | null = null;
  try {
    const body = await postJson<{ candidates: typeof found[]; warning?: string | null }>('/api/books/lookup', {
      query: title,
      ...(author ? { author } : {}),
    });
    found = body.candidates?.[0] ?? null;
    lookupWarning = body.warning ?? null;
  } catch {
    found = null;
    lookupWarning = '書誌情報を取得できませんでした';
  }

  await postJson('/api/books', {
    title: found?.title ?? title,
    authors: author ? [author] : found?.authors ?? [],
    isbn13: found?.isbn13 ?? null,
    publisher: found?.publisher ?? null,
    publishedOn: found?.publishedOn ?? null,
    coverUrl: found?.coverUrl ?? null,
    rating: ratingValue > 0 ? ratingValue : null,
    review: review || null,
  });

  if (titleInput) titleInput.value = '';
  const authorInput = document.getElementById('booksAddAuthor') as HTMLInputElement | null;
  if (authorInput) authorInput.value = '';
  const reviewInput = document.getElementById('booksAddReview') as HTMLTextAreaElement | null;
  if (reviewInput) reviewInput.value = '';
  // 書誌が引けなくても登録は通る。 失敗したソースだけを添える。
  setStatus('booksAddStatus', lookupWarning ? `登録しました — ${lookupWarning}` : '登録しました');
  await Promise.all([loadShelf(), loadNewReleases()]);
}

/** ボタンを押している間だけ無効化して、 二重起動を防ぐ。 */
async function withBusy(buttonId: string, label: string, run: () => Promise<void>): Promise<void> {
  const button = document.getElementById(buttonId) as HTMLButtonElement | null;
  const original = button?.textContent ?? label;
  if (button) { button.disabled = true; button.textContent = '実行中…'; }
  try {
    await run();
  } catch (error) {
    setStatus('booksJobStatus', `失敗: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

function template(): string {
  return `<div class="bk-view foundation-form">
    <header class="bk-header">
      <div>
        <h2>📚 本</h2>
        <p>良かった本を残しておくと、その著者・シリーズの新刊を週 1 で見に行き、傾向から次の 1 冊を提案します。</p>
      </div>
      <div class="bk-header-actions">
        <button id="booksCheckNew" type="button">新刊をチェック</button>
        <button id="booksRefreshSuggest" type="button">サジェストを作る</button>
        <span id="booksJobStatus" class="muted"></span>
      </div>
    </header>

    <section class="bk-section">
      <h3>良かった本を登録</h3>
      <div class="bk-add">
        <input id="booksAddTitle" type="text" placeholder="タイトル" autocomplete="off">
        <input id="booksAddAuthor" type="text" placeholder="著者 (任意)" autocomplete="off">
        <select id="booksAddRating">
          ${[0, 1, 2, 3, 4, 5].map((value) => `<option value="${value}"${value === 5 ? ' selected' : ''}>${value === 0 ? '評価なし' : `★${value}`}</option>`).join('')}
        </select>
        <button id="booksAddSubmit" type="button">登録</button>
      </div>
      <textarea id="booksAddReview" rows="2" placeholder="感想 (任意) — サジェストの材料になります"></textarea>
      <span id="booksAddStatus" class="muted"></span>
    </section>

    <section class="bk-section">
      <h3>📖 新刊</h3>
      <div id="booksWatchTargets" class="bk-tags"></div>
      <ul id="booksNewReleases" class="bk-list"><li class="empty">読み込み中…</li></ul>
    </section>

    <section class="bk-section">
      <h3>💡 読んでみては</h3>
      <ul id="booksSuggestions" class="bk-list"><li class="empty">読み込み中…</li></ul>
    </section>

    <section class="bk-section">
      <h3>🗂 本棚</h3>
      <div class="bk-filters">
        <input id="booksSearch" type="search" placeholder="タイトル / 著者 / タグで検索">
        <label><input id="booksFavoritesOnly" type="checkbox" checked> お気に入りのみ</label>
        <span id="booksCounts" class="muted"></span>
      </div>
      <ul id="booksList" class="bk-list"><li class="empty">読み込み中…</li></ul>
    </section>

    <details class="bk-settings">
      <summary>読破記録の取り込み (年 1 回)</summary>
      <p class="bk-caution">Kindle の読破記録は公式 API がありません。Amazon の「データのリクエスト」で書き出した CSV、Kindle 端末の My Clippings.txt、ブクログ・読書メーターのエクスポート CSV を貼り付けてください。評価と感想は上書きしません。</p>
      <textarea id="booksImportText" rows="6" placeholder="CSV / My Clippings.txt の中身を貼り付け"></textarea>
      <div class="bk-settings-actions">
        <button id="booksImportSubmit" type="button">取り込む</button>
        <span id="booksImportState" class="muted"></span>
      </div>
    </details>

    <details class="bk-settings">
      <summary>設定</summary>
      <div class="bk-settings-head">
        <label><span>週次チェック</span><input id="booksEnabled" type="checkbox"></label>
        <label><span>曜日</span>
          <select id="booksWeeklyDay">${WEEKDAYS.map((name, index) => `<option value="${index}">${name}</option>`).join('')}</select>
        </label>
        <label><span>時刻</span><input id="booksWeeklyHour" type="number" min="0" max="23"></label>
        <label><span>ウォッチ対象の下限評価</span><input id="booksMinRating" type="number" min="1" max="5"></label>
        <label><span>サジェスト件数</span><input id="booksSuggestionCount" type="number" min="1" max="30"></label>
      </div>
      <div class="bk-settings-head">
        <label><span>Google Books</span><input id="booksSourceGoogle" type="checkbox"></label>
        <label><span>openBD</span><input id="booksSourceOpenbd" type="checkbox"></label>
        <label><span>NDL サーチ</span><input id="booksSourceNdl" type="checkbox"></label>
        <label><span>楽天ブックス</span><input id="booksSourceRakuten" type="checkbox"></label>
      </div>
      <label class="bk-rakuten"><span>楽天アプリ ID</span>
        <input id="booksRakutenId" type="text" placeholder="売れ筋ランキングを使うときだけ必要" autocomplete="off">
      </label>
      <div class="bk-settings-actions">
        <button id="booksSaveConfig" type="button">設定を保存</button>
        <span id="booksConfigStatus" class="muted"></span>
      </div>
    </details>
  </div>`;
}

function bindEvents(element: HTMLElement): void {
  document.getElementById('booksAddSubmit')?.addEventListener('click', () => {
    void withBusy('booksAddSubmit', '登録', addBook);
  });
  document.getElementById('booksSearch')?.addEventListener('input', () => { void loadShelf(); });
  document.getElementById('booksFavoritesOnly')?.addEventListener('change', () => { void loadShelf(); });
  document.getElementById('booksSaveConfig')?.addEventListener('click', () => {
    void withBusy('booksSaveConfig', '設定を保存', saveConfig);
  });

  document.getElementById('booksCheckNew')?.addEventListener('click', () => {
    void withBusy('booksCheckNew', '新刊をチェック', async () => {
      const body = await postJson<{ result: { found: unknown[]; checkedTargets: number; errors: string[] } }>(
        '/api/books/new-releases/check', {},
      );
      const warning = body.result.errors.length > 0 ? ` / 取得失敗 ${body.result.errors.length} 件` : '';
      setStatus('booksJobStatus', `${body.result.checkedTargets} 対象を確認 / 新刊 ${body.result.found.length} 件${warning}`);
      await loadNewReleases();
    });
  });

  document.getElementById('booksRefreshSuggest')?.addEventListener('click', () => {
    void withBusy('booksRefreshSuggest', 'サジェストを作る', async () => {
      const body = await postJson<{ result: { suggestions: unknown[]; errors: string[] } }>(
        '/api/books/suggestions/refresh', {},
      );
      const warning = body.result.errors.length > 0 ? ` / 取得失敗 ${body.result.errors.length} 件` : '';
      setStatus('booksJobStatus', `候補 ${body.result.suggestions.length} 件${warning}`);
      await loadSuggestions();
    });
  });

  document.getElementById('booksImportSubmit')?.addEventListener('click', () => {
    void withBusy('booksImportSubmit', '取り込む', async () => {
      const text = (document.getElementById('booksImportText') as HTMLTextAreaElement | null)?.value ?? '';
      if (!text.trim()) { setStatus('booksImportState', '内容を貼り付けてください'); return; }
      const body = await postJson<{ result: { parsed: number; inserted: number; updated: number } }>(
        '/api/books/import', { text, format: 'auto' },
      );
      setStatus('booksImportState',
        `${body.result.parsed} 件を読み取り / 新規 ${body.result.inserted} 件 · 更新 ${body.result.updated} 件`);
      await loadShelf();
    });
  });

  // カード内のボタンは動的に差し替わるので委譲で拾う。
  element.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const releaseId = target.closest('.bk-dismiss-release')?.getAttribute('data-release-id');
    if (releaseId) {
      void postJson(`/api/books/new-releases/${releaseId}/dismiss`, {}).then(loadNewReleases);
      return;
    }
    const suggestionId = target.closest('.bk-dismiss-suggestion')?.getAttribute('data-suggestion-id');
    if (suggestionId) {
      void postJson(`/api/books/suggestions/${suggestionId}/dismiss`, {}).then(loadSuggestions);
      return;
    }
    const deleteId = target.closest('.bk-delete')?.getAttribute('data-book-id');
    if (deleteId) {
      void request(`/api/books/${deleteId}`, { method: 'DELETE' }).then(loadShelf);
    }
  });

  element.addEventListener('change', (event) => {
    const select = event.target as HTMLSelectElement | null;
    if (!select?.classList.contains('bk-rate-select')) return;
    const id = select.getAttribute('data-book-id');
    if (!id) return;
    const rating = Number(select.value);
    void request(`/api/books/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: rating > 0 ? rating : null }),
    }).then(() => Promise.all([loadShelf(), loadNewReleases()]));
  });
}

function initialize(): void {
  const element = root();
  if (!element || initialized) return;
  initialized = true;
  element.innerHTML = template();
  bindEvents(element);
}

export async function loadBooksView(): Promise<void> {
  initialize();
  try {
    await loadConfig();
    await Promise.all([loadShelf(), loadNewReleases(), loadSuggestions()]);
  } catch (error) {
    const list = document.getElementById('booksList');
    if (list) {
      list.innerHTML = `<li class="empty">読み込み失敗: ${escapeHtml(error instanceof Error ? error.message : String(error))}</li>`;
    }
  }
}
