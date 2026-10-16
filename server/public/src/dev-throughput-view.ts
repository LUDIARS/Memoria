// 📒 作業記録 > 📊 開発量。 Revisor でマージされた PR の件数と GitHub (LUDIARS org) のコミット件数を、
// JST の 1 日ごとに直近 30 日並べる。 集計はサーバが 1 時間ごとに行い、 ここは保存済みの値を見せるだけ。

import { escapeHtml } from './shared/sanitize.js';

interface DailyView {
  day: string;
  rvMerged: number | null;
  rvByRepo: Record<string, number>;
  commits: number | null;
  codeAdditions: number | null;
}

interface SyncStatus {
  running: boolean;
  lastFinishedAt: string | null;
  lastError: string | null;
}

interface DevThroughputResponse {
  days: DailyView[];
  sync: SyncStatus;
}

const VIEW_DAYS = 30;
const TOP_REPOS = 3;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d} (${weekday})`;
}

function bar(value: number | null, max: number, kind: string): string {
  if (value === null) return '<span class="muted">—</span>';
  const width = max > 0 ? Math.round((value / max) * 100) : 0;
  return `<span class="dt-bar dt-bar-${kind}" style="width:${width}%"></span><span class="dt-num">${value}</span>`;
}

function topRepos(byRepo: Record<string, number>): string {
  return Object.entries(byRepo)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_REPOS)
    .map(([repo, count]) => `${escapeHtml(repo.replace(/^LUDIARS\//, ''))} ${count}`)
    .join(' · ');
}

function sum(values: (number | null)[]): { total: number; days: number } {
  const known = values.filter((v): v is number => v !== null);
  return { total: known.reduce((a, b) => a + b, 0), days: known.length };
}

function average({ total, days }: { total: number; days: number }): string {
  return days ? (total / days).toFixed(1) : '—';
}

function syncLine(sync: SyncStatus): string {
  if (sync.running) return '集計中…';
  const at = sync.lastFinishedAt ? new Date(sync.lastFinishedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'まだ';
  const error = sync.lastError ? ` <span class="dt-error">⚠ ${escapeHtml(sync.lastError)}</span>` : '';
  return `最終集計 ${escapeHtml(at)}${error}`;
}

export function renderDevThroughput(data: DevThroughputResponse): string {
  const merged = sum(data.days.map((d) => d.rvMerged));
  const commits = sum(data.days.map((d) => d.commits));
  const additions = sum(data.days.map(d => d.codeAdditions ?? null));
  const maxAdditions = Math.max(0, ...data.days.map(d => d.codeAdditions ?? 0));
  const maxMerged = Math.max(0, ...data.days.map((d) => d.rvMerged ?? 0));
  const maxCommits = Math.max(0, ...data.days.map((d) => d.commits ?? 0));
  const rows = data.days.map((d) => `<tr>
      <td class="dt-day">${escapeHtml(dayLabel(d.day))}</td>
      <td class="dt-cell">${bar(d.rvMerged, maxMerged, 'merge')}</td>
      <td class="dt-cell">${bar(d.commits, maxCommits, 'commit')}</td>
      <td class="dt-cell">${bar(d.codeAdditions ?? null, maxAdditions, 'commit')}</td>
      <td class="dt-repos muted">${topRepos(d.rvByRepo)}</td>
    </tr>`).join('');
  return `<div class="wl-summary-row dt-head">
      <span><b>直近 ${data.days.length} 日</b> · Rv マージ 計 ${merged.total} (1 日平均 ${average(merged)}) · コミット 計 ${commits.total} (1 日平均 ${average(commits)}) · コード追加 ${additions.days ? additions.total.toLocaleString('ja-JP') : '—'} 行 (集計済み ${additions.days} 日・1 日平均 ${average(additions)} 行)</span>
      <span class="grow"></span>
      <span class="muted dt-sync">${syncLine(data.sync)}</span>
      <button type="button" class="ghost" id="devThroughputSync">今すぐ集計</button>
    </div>
    <p class="muted dt-note">Rv マージ = Revisor でマージされた PR の数 (マージ済み PR の最終更新日で数える)。 コミット = GitHub の LUDIARS org の既定ブランチに載ったコミットの数。 コード追加行数 = 同じ GitHub 組織の非マージコミットで追加されたソースの行数（生成物を除外、削除行は差し引かない）。— は未集計。日付は日本時間。</p>
    <div style="overflow-x:auto"><table class="dt-table">
      <thead><tr><th>日付</th><th>Rv マージ</th><th>コミット</th><th>コード追加行数</th><th>マージの多いリポ</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

async function requestSync(): Promise<void> {
  await fetch('/api/dev-throughput/sync', { method: 'POST' });
}

export async function loadDevThroughputView(): Promise<void> {
  const root = document.getElementById('devThroughputRoot');
  if (!root) return;
  root.innerHTML = '<div class="empty">読み込み中…</div>';
  try {
    const response = await fetch(`/api/dev-throughput?days=${VIEW_DAYS}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    root.innerHTML = renderDevThroughput(await response.json() as DevThroughputResponse);
    document.getElementById('devThroughputSync')?.addEventListener('click', () => {
      void requestSync().then(() => setTimeout(() => void loadDevThroughputView(), 3000));
    });
  } catch (error) {
    root.innerHTML = `<div class="empty">読み込み失敗: ${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
  }
}
