// 🤖 AI タブ > 📈 トレンド。 トレンドの集積は Tendentia (別サービス) が持つので、 ここは要点だけを見せる。
// ジャンルごとの注目と複数サイトで話題のもの。 マップや設定は「Tendentia で開く」から Tendentia の画面で。

import { escapeHtml } from './shared/sanitize.js';

interface TendentiaHighlight {
  title: string;
  url: string | null;
  sourceName: string;
  rank: number;
  reasons: string[];
}

interface TendentiaSummary {
  lastCrawledAt: string | null;
  crossHits: { title: string; sourceNames: string[] }[];
  genres: { genre: string; label: string; highlights: TendentiaHighlight[] }[];
}

type TendentiaLinkResponse =
  | { available: true; openUrl: string; summary: TendentiaSummary }
  | { available: false; openUrl: string | null; reason: string };

const REASON_LABELS: Record<string, string> = { cross: '複数サイト', new: '新登場', up: '急上昇' };

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function openButton(url: string | null): string {
  return url ? `<a class="td-open" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Tendentia で開く ↗</a>` : '';
}

function highlightItem(h: TendentiaHighlight): string {
  const title = h.url
    ? `<a href="${escapeHtml(h.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(h.title)}</a>`
    : escapeHtml(h.title);
  const reasons = h.reasons.map((r) => `<span class="td-reason td-reason-${escapeHtml(r)}">${escapeHtml(REASON_LABELS[r] ?? r)}</span>`).join('');
  return `<li>${reasons}<span class="td-title">${title}</span><span class="muted">${escapeHtml(h.sourceName)} ${h.rank}位</span></li>`;
}

export function renderTendentia(data: TendentiaLinkResponse): string {
  const header = `<header class="td-head"><div><h2>📈 トレンド</h2><p class="muted">トレンドの集積は Tendentia が行っています。ここではジャンルごとの注目だけを表示します。</p></div>${openButton(data.openUrl)}</header>`;
  // フロントエンドの tsconfig は strictNullChecks を切っているので、 boolean の判別では型が絞れない。 'in' で分ける。
  if ('reason' in data) return `${header}<div class="empty">${escapeHtml(data.reason)}</div>`;
  const { summary } = data;
  const cross = summary.crossHits.length
    ? `<section class="td-card"><h3>複数のサイトで話題</h3><ul class="td-list">${summary.crossHits.map((hit) =>
      `<li><span class="td-title">${escapeHtml(hit.title)}</span><span class="muted">${escapeHtml(hit.sourceNames.join(' · '))}</span></li>`).join('')}</ul></section>`
    : '';
  const genres = summary.genres.length
    ? `<div class="td-grid">${summary.genres.map((g) => `<section class="td-card"><h3>${escapeHtml(g.label)}</h3><ul class="td-list">${g.highlights.map(highlightItem).join('')}</ul></section>`).join('')}</div>`
    : '<div class="empty">今は注目 (新登場・急上昇・複数サイト) がありません。</div>';
  return `${header}<p class="muted td-crawled">最終巡回 ${escapeHtml(fmtTime(summary.lastCrawledAt))}</p>${cross}${genres}`;
}

export async function loadTendentiaView(): Promise<void> {
  const root = document.getElementById('tendentiaRoot');
  if (!root) return;
  root.innerHTML = '<div class="empty">読み込み中…</div>';
  try {
    const response = await fetch('/api/tendentia/summary');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    root.innerHTML = `<div class="td-view">${renderTendentia(await response.json() as TendentiaLinkResponse)}</div>`;
  } catch (error) {
    root.innerHTML = `<div class="empty">読み込み失敗: ${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
  }
}
