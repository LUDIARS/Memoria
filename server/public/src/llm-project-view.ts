export interface ProjectCostRow {
  project_key: string | null;
  project_name: string | null;
  attribution_sources: string | null;
  cost_usd: number;
  total_tokens: number;
  responses: number;
  sessions: number;
  unpriced_responses: number;
}

export function renderProjectCosts(rows: ProjectCostRow[]): string {
  return `<section class="llm-section"><h3>プロジェクト別コスト</h3>
    <p class="muted">選択期間の作業対象ごとに集計しています。途中で対象が変わったセッションは応答ごとに分けます。金額は請求額ではなく公式API換算です。</p>
    <div class="llm-table-wrap"><table class="llm-table"><thead><tr>
    <th>プロジェクト</th><th>判定の根拠</th><th class="num">セッション</th><th class="num">応答</th>
    <th class="num">Tokens</th><th class="num">USD</th><th class="num">料金未評価の応答</th>
    </tr></thead><tbody>${rows.map((row) => `<tr>
      <td>${escapeHtml(row.project_name ?? '未判定')}</td><td>${escapeHtml(evidenceLabel(row.attribution_sources))}</td>
      <td class="num">${formatNumber(row.sessions)}</td><td class="num">${formatNumber(row.responses)}</td>
      <td class="num">${formatNumber(row.total_tokens)}</td><td class="num">${projectCost(row)}</td>
      <td class="num">${formatNumber(row.unpriced_responses)}</td></tr>`).join('') || '<tr><td colspan="7">この期間の記録はありません。</td></tr>'}
    </tbody></table></div><p class="muted">未判定の費用も総額に含みます。1セッションが複数プロジェクトに現れるため、セッション数は足し合わせられません。古い記録は「ログを更新」で再判定します。元ログがない分は未判定のまま残します。</p></section>`;
}

export function renderSessionProjects(rows: ProjectCostRow[]): string {
  return rows.map((row) => `<small>${escapeHtml(row.project_name ?? '未判定')}: ${projectCost(row)}${row.unpriced_responses && row.unpriced_responses < row.responses ? ' + 料金未評価あり' : ''}</small>`).join('');
}

function projectCost(row: ProjectCostRow): string {
  return row.responses > 0 && row.unpriced_responses === row.responses ? '未評価' : usd(row.cost_usd);
}

function evidenceLabel(sources: string | null): string {
  if (!sources) return '根拠なし・再読込待ち';
  return sources.split(',').map((source) => source === 'declared-project' ? '作業対象の明示記録' : '作業フォルダの所属').join(' / ');
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char);
}
function formatNumber(value: number): string { return new Intl.NumberFormat('ja-JP').format(value); }
function usd(value: number): string { return `$${value.toFixed(3)}`; }
