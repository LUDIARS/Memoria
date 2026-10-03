/**
 * 集計結果を Villa 配信用の単一 HTML (外部依存なし) に描く。
 */
import type { MonthVolume, VolumeReport } from './types.js';

const NF = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function n(v: number): string {
  return NF.format(v);
}

function bar(value: number, max: number): string {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return `<span class="bar"><span style="width:${pct.toFixed(1)}%"></span></span>`;
}

function monthRow(m: MonthVolume, maxCode: number): string {
  return `<tr>
<th scope="row">${esc(m.month)}</th>
<td>${n(m.commits)}</td>
<td>${n(m.repos)}</td>
<td class="code">${n(m.codeChanged)}${bar(m.codeChanged, maxCode)}</td>
<td class="code">${n(m.weeklyAvgCodeChanged)}</td>
<td>+${n(m.codeAdditions)} / −${n(m.codeDeletions)}</td>
<td class="muted">${n(m.changed)}</td>
<td class="muted">${n(m.weeklyAvgChanged)}</td>
</tr>`;
}

export interface RenderOptions {
  overflowDays?: string[];
  /** 名前を出さないリポ (非公開)。 まとめて「非公開リポ (N 件)」 と表示する */
  privateRepos?: ReadonlySet<string>;
}

function repoBlock(m: MonthVolume, privateRepos: ReadonlySet<string>): string {
  if (m.topRepos.length === 0) return `<li><b>${esc(m.month)}</b> <span class="muted">コミットなし</span></li>`;
  const shown = m.topRepos.filter((r) => !privateRepos.has(r.repo));
  const hidden = m.topRepos.filter((r) => privateRepos.has(r.repo));
  const parts = shown.map((r) => `${esc(r.repo)} <span class="muted">${n(r.codeChanged)}</span>`);
  if (hidden.length > 0) {
    const sum = hidden.reduce((s, r) => s + r.codeChanged, 0);
    parts.push(`非公開リポ (${hidden.length} 件) <span class="muted">${n(sum)}</span>`);
  }
  const items = parts.join('、');
  const note = m.truncatedCommits > 0 ? ` <span class="warn">(ファイル数上限で下限値: ${m.truncatedCommits} 件)</span>` : '';
  return `<li><b>${esc(m.month)}</b> ${items}${note}</li>`;
}

export function renderVolumeHtml(report: VolumeReport, opts: RenderOptions = {}): string {
  const privateRepos = opts.privateRepos ?? new Set<string>();
  const maxCode = Math.max(0, ...report.months.map((m) => m.codeChanged));
  const authors = report.authors.map((a) => `${a.kind === 'login' ? '@' : ''}${esc(a.value)}`).join('、');
  const overflow = opts.overflowDays?.length
    ? `<p class="warn">検索上限 (1 日 1000 件) を超えた日があり、 取りこぼしがあります: ${opts.overflowDays.map(esc).join('、')}</p>`
    : '';
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>コード変更量</title>
<style>
:root { --bg:#fbfaf7; --fg:#1d1f23; --muted:#6b7078; --line:#e3e0d8; --accent:#2f6fd0; --warn:#a6501a; --card:#ffffff; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#16181c; --fg:#e8e6e1; --muted:#9aa0a8; --line:#2c3036; --accent:#7aa7ff; --warn:#f0a36b; --card:#1d2025; } }
:root[data-theme="dark"] { --bg:#16181c; --fg:#e8e6e1; --muted:#9aa0a8; --line:#2c3036; --accent:#7aa7ff; --warn:#f0a36b; --card:#1d2025; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 system-ui, "Hiragino Sans", "Yu Gothic UI", sans-serif; }
main { max-width:1040px; margin:0 auto; padding:24px 16px 48px; }
h1 { font-size:22px; margin:0 0 4px; }
.muted { color:var(--muted); }
.warn { color:var(--warn); }
.tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; margin:20px 0; }
.tile { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
.tile b { display:block; font-size:24px; font-variant-numeric:tabular-nums; }
.scroll { overflow-x:auto; background:var(--card); border:1px solid var(--line); border-radius:10px; }
table { border-collapse:collapse; width:100%; min-width:760px; font-variant-numeric:tabular-nums; }
th, td { padding:8px 10px; border-bottom:1px solid var(--line); text-align:right; white-space:nowrap; }
th[scope="row"], thead th:first-child { text-align:left; }
thead th { font-size:13px; color:var(--muted); font-weight:600; }
td.code { font-weight:600; }
.bar { display:inline-block; vertical-align:middle; width:90px; height:8px; margin-left:8px; background:var(--line); border-radius:4px; overflow:hidden; }
.bar span { display:block; height:100%; background:var(--accent); }
ul { padding-left:18px; }
</style>
</head>
<body>
<main>
<h1>コード変更量 (GitHub 上のコミット)</h1>
<p class="muted">対象: ${authors} ／ 生成: ${esc(report.generatedAt)} ／ 月の境界: ${esc(report.timeZone)}</p>
${overflow}
<div class="tiles">
<div class="tile"><span class="muted">月平均 (コード)</span><b>${n(report.monthlyAvgCodeChanged)} 行</b></div>
<div class="tile"><span class="muted">週平均 (コード)</span><b>${n(report.weeklyAvgCodeChanged)} 行</b></div>
<div class="tile"><span class="muted">月平均 (全ファイル)</span><b>${n(report.monthlyAvgChanged)} 行</b></div>
<div class="tile"><span class="muted">週平均 (全ファイル)</span><b>${n(report.weeklyAvgChanged)} 行</b></div>
</div>
<div class="scroll">
<table>
<thead><tr><th>月</th><th>コミット</th><th>リポ</th><th>コード変更行</th><th>週平均</th><th>追加 / 削除</th><th>全ファイル</th><th>全ファイル週平均</th></tr></thead>
<tbody>
${report.months.map((m) => monthRow(m, maxCode)).join('\n')}
</tbody>
</table>
</div>
<h2>月ごとの主なリポ (コード変更行)</h2>
<ul>
${report.months.map((m) => repoBlock(m, privateRepos)).join('\n')}
</ul>
<h2>数え方</h2>
<ul>
<li>非公開リポは名前を伏せ、 月ごとに 「非公開リポ」 としてまとめる。</li>
<li>変更行 = 追加行 + 削除行。 GitHub のコミット検索で本人の識別子に当たった、 merge 以外のコミットを数える (既定ブランチに載ったものだけ)。</li>
<li>「コード」 はソース拡張子のファイルに限り、 node_modules・dist・build・vendor・third_party・generated 等とロックファイルを除く。 「全ファイル」 は除外なし。</li>
<li>週平均 = 月合計 ÷ (その月の日数 ÷ 7)。 上部の週平均は選んだ月の合計 ÷ (総日数 ÷ 7)、 月平均は選んだ月数で割った値。</li>
</ul>
</main>
</body>
</html>
`;
}
