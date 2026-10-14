// 🤖 AI タブ > 📈 トレンド > マップ表示。
// トレンド 1 つ 1 つを図形で並べる。 色 = ジャンル、 大きさと丸さ = 興味の度合い。
// 興味が強いほど大きく丸く (上位は円)、 弱いほど小さな角丸の四角になるが、 最小の大きさで必ず残る。
// 興味 = ジャンルごとの興味の強さ・気になる言葉 (自分で決める) × よく開くジャンル・話題 (開いた記録から学ぶ)。

import { escapeHtml } from './shared/sanitize.js';

type TrendGenre =
  | 'general' | 'youth' | 'news' | 'tech' | 'game' | 'anime' | 'music'
  | 'app' | 'book' | 'entertainment' | 'life' | 'global';
type MovementStatus = 'new' | 'up' | 'down' | 'same' | 'unknown';

interface TrendInterestPrefs {
  genreWeights: Partial<Record<TrendGenre, number>>;
  keywords: string[];
}

interface TrendMapTile {
  key: string;
  title: string;
  subtitle: string | null;
  url: string | null;
  metric: string | null;
  genre: TrendGenre;
  sourceId: string;
  sourceName: string;
  rank: number;
  movement: { status: MovementStatus; delta: number | null };
  interest: number;
  reasons: string[];
}

interface TrendMapGenre {
  genre: TrendGenre;
  label: string;
  weight: number;
  count: number;
}

interface TrendMap {
  lastCrawledAt: string | null;
  prefs: TrendInterestPrefs;
  genres: TrendMapGenre[];
  tiles: TrendMapTile[];
}

/** 興味 0 のときの一辺 (px)。 これより小さくはしない = 消えない。 */
const MIN_SIZE = 64;
/** 興味 1 のときに足す大きさ (px)。 */
const SIZE_RANGE = 80;
/** これ以上の興味は円にする。 */
const CIRCLE_FROM = 0.75;

const WEIGHT_STEPS: { value: number; label: string }[] = [
  { value: 0, label: 'ほぼ興味なし' },
  { value: 0.5, label: '少し' },
  { value: 1, label: 'ふつう' },
  { value: 2, label: '興味あり' },
  { value: 3, label: 'とても興味あり' },
];

let current: TrendMap | null = null;
let selectedGenre: TrendGenre | 'all' = 'all';
let root: HTMLElement | null = null;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

/** 興味 (0〜1) から図形の大きさと角の丸さを決める。 */
export function tileGeometry(interest: number): { width: number; height: number; radius: string; fontSize: number } {
  const i = Math.min(1, Math.max(0, interest));
  const size = Math.round(MIN_SIZE + SIZE_RANGE * i);
  const fontSize = Math.round(11 + 5 * i);
  if (i >= CIRCLE_FROM) return { width: size, height: size, radius: '50%', fontSize };
  // 興味が上がるほど角が丸くなり、 横長から正方形へ近づく。
  const width = Math.round(size * (1.7 - 0.6 * i));
  const height = Math.round(size * (0.7 + 0.2 * i));
  return { width, height, radius: `${Math.round(8 + 22 * i)}px`, fontSize };
}

function tileHtml(tile: TrendMapTile, index: number): string {
  const g = tileGeometry(tile.interest);
  const why = [
    `${tile.sourceName} ${tile.rank}位`,
    tile.metric ?? '',
    tile.reasons.length ? `大きさの理由: ${tile.reasons.join(' / ')}` : '',
    `興味 ${Math.round(tile.interest * 100)}%`,
  ].filter(Boolean).join('\n');
  const badge = tile.movement.status === 'new' ? '<span class="tm-badge">NEW</span>'
    : tile.movement.status === 'up' ? `<span class="tm-badge tm-badge-up">↑${tile.movement.delta}</span>` : '';
  const style = `width:${g.width}px;height:${g.height}px;border-radius:${g.radius};font-size:${g.fontSize}px`;
  const inner = `${badge}<span class="tm-title">${escapeHtml(tile.title)}</span>`;
  const attrs = `class="tm-tile tm-g-${tile.genre}" style="${style}" title="${escapeHtml(`${tile.title}\n${why}`)}" data-index="${index}"`;
  return tile.url
    ? `<a ${attrs} href="${escapeHtml(tile.url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<div ${attrs}>${inner}</div>`;
}

function weightOptions(weight: number): string {
  return WEIGHT_STEPS.map((step) =>
    `<option value="${step.value}"${step.value === weight ? ' selected' : ''}>${escapeHtml(step.label)}</option>`).join('');
}

function legendHtml(map: TrendMap): string {
  const chips = map.genres.map((genre) => `<div class="tm-legend-item">
      <button type="button" class="tm-chip tm-g-${genre.genre}${selectedGenre === genre.genre ? ' active' : ''}" data-genre="${genre.genre}" title="このジャンルだけ表示">${escapeHtml(genre.label)} <span class="muted">${genre.count}</span></button>
      <select class="tm-weight" data-genre="${genre.genre}" aria-label="${escapeHtml(genre.label)} の興味">${weightOptions(genre.weight)}</select>
    </div>`).join('');
  return `<div class="tm-legend">
    <button type="button" class="tm-chip tm-chip-all${selectedGenre === 'all' ? ' active' : ''}" data-genre="all">すべて</button>
    ${chips}
  </div>`;
}

function render(): void {
  if (!root || !current) return;
  const map = current;
  const tiles = selectedGenre === 'all' ? map.tiles : map.tiles.filter((tile) => tile.genre === selectedGenre);
  root.innerHTML = `<div class="tm-view foundation-form">
    <p class="tm-help muted">色はジャンル、 大きさと丸さは興味の度合いです。 ジャンルごとの興味と気になる言葉で大きさが変わり、 開いた話題やよく開くジャンルも少しずつ大きくなります。 興味が薄いものも小さく残ります。</p>
    ${legendHtml(map)}
    <div class="tm-keywords">
      <label><span>気になる言葉 (読点・カンマ・改行で区切る)</span><input id="trendMapKeywords" type="text" maxlength="800" value="${escapeHtml(map.prefs.keywords.join('、'))}" placeholder="例: AI、ゲーム、ラーメン"></label>
      <button type="button" id="trendMapSaveKeywords">保存</button>
      <span id="trendMapStatus" class="muted"></span>
    </div>
    ${tiles.length ? `<div class="tm-field">${tiles.map((tile) => tileHtml(tile, map.tiles.indexOf(tile))).join('')}</div>`
      : '<div class="empty">まだトレンドがありません。「今すぐ巡回」を押すか、 次の自動巡回を待ってください。</div>'}
  </div>`;
  bind();
}

function setStatus(text: string): void {
  const status = document.getElementById('trendMapStatus');
  if (status) status.textContent = text;
}

/** 開いた記録を送る。 リンクは別タブで開くので、 ページ遷移に巻き込まれないよう keepalive で投げっぱなしにする。 */
function recordClick(tile: TrendMapTile): void {
  void fetch('/api/trend-crawler/click', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: tile.key, genre: tile.genre, sourceId: tile.sourceId }),
    keepalive: true,
  }).catch(() => { /* 記録できなくても表示は変えない */ });
}

async function savePrefs(next: TrendInterestPrefs): Promise<void> {
  setStatus('保存しています…');
  try {
    await request<TrendInterestPrefs>('/api/trend-crawler/interest', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
    });
    await reload();
    setStatus('保存しました');
  } catch (error) {
    setStatus(`保存失敗: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseKeywords(text: string): string[] {
  return [...new Set(text.split(/[、,，\n]/).map((word) => word.trim()).filter(Boolean))].slice(0, 50);
}

function bind(): void {
  if (!root || !current) return;
  root.querySelectorAll<HTMLButtonElement>('.tm-chip[data-genre]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedGenre = button.dataset.genre as TrendGenre | 'all';
      render();
    });
  });
  root.querySelectorAll<HTMLSelectElement>('.tm-weight').forEach((select) => {
    select.addEventListener('change', () => {
      if (!current) return;
      const genre = select.dataset.genre as TrendGenre;
      const weights = { ...current.prefs.genreWeights, [genre]: Number(select.value) };
      void savePrefs({ ...current.prefs, genreWeights: weights });
    });
  });
  document.getElementById('trendMapSaveKeywords')?.addEventListener('click', () => {
    if (!current) return;
    const input = document.getElementById('trendMapKeywords') as HTMLInputElement | null;
    void savePrefs({ ...current.prefs, keywords: parseKeywords(input?.value ?? '') });
  });
  root.querySelectorAll<HTMLElement>('.tm-tile[data-index]').forEach((element) => {
    element.addEventListener('click', () => {
      const tile = current?.tiles[Number(element.dataset.index)];
      if (tile) recordClick(tile);
    });
  });
}

async function reload(): Promise<void> {
  const response = await request<{ map: TrendMap }>('/api/trend-crawler/map');
  current = response.map;
  if (selectedGenre !== 'all' && !current.genres.some((genre) => genre.genre === selectedGenre)) selectedGenre = 'all';
  render();
}

export async function loadTrendMap(container: HTMLElement): Promise<void> {
  root = container;
  try {
    await reload();
  } catch (error) {
    container.innerHTML = `<div class="empty">読み込み失敗: ${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
  }
}
