// 今月の目標タブ — 目標 (kind='goal') 一覧 + 毎朝 7 時の評価記録を表示。

interface GoalTask {
  id: number;
  title: string;
  status: 'todo' | 'doing' | 'done';
  details: string | null;
  due_at: string | null;
}

interface GoalEvalLog {
  goal_id: number;
  date: string;
  status: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusBadge(status: string): string {
  if (status === 'done')  return '<span class="goals-badge goals-badge-done">✅ 達成</span>';
  if (status === 'doing') return '<span class="goals-badge goals-badge-doing">🔄 進行中</span>';
  return '<span class="goals-badge goals-badge-todo">📋 未着手</span>';
}

function currentMonth(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function monthLabel(m: string): string {
  const [y, mo] = m.split('-');
  return `${y}年${Number(mo)}月の目標`;
}

function renderDotRow(logs: GoalEvalLog[]): string {
  if (!logs.length) {
    return '<div class="goals-dot-row goals-dot-empty">まだ評価記録なし (毎朝 7 時に自動記録)</div>';
  }
  const dots = logs.map(e => {
    const day = e.date.slice(8); // DD
    const label = e.date + ' ' + (e.status === 'done' ? '達成' : e.status === 'doing' ? '進行中' : '未着手');
    return `<span class="goals-dot goals-dot-${e.status}" title="${label}">${Number(day)}</span>`;
  }).join('');
  return `<div class="goals-dot-row">${dots}</div>`;
}

export async function loadGoalsView(): Promise<void> {
  const root = document.getElementById('goalsRoot');
  if (!root) return;

  root.innerHTML = '<div class="muted goals-loading">読み込み中…</div>';

  const month = currentMonth();
  const [goalsRes, evalsRes] = await Promise.all([
    fetch('/api/tasks?kind=goal&limit=200'),
    fetch(`/api/goal-evals?month=${month}`),
  ]);

  const goals: GoalTask[] = goalsRes.ok ? (await goalsRes.json() as GoalTask[]) : [];
  const evals: GoalEvalLog[] = evalsRes.ok ? (await evalsRes.json() as GoalEvalLog[]) : [];

  const evalByGoal = new Map<number, GoalEvalLog[]>();
  for (const e of evals) {
    if (!evalByGoal.has(e.goal_id)) evalByGoal.set(e.goal_id, []);
    evalByGoal.get(e.goal_id)!.push(e);
  }

  const header = `
    <div class="goals-header">
      <span class="goals-month-label">${monthLabel(month)}</span>
      <span class="goals-count muted">${goals.length} 件</span>
      <button id="goalsRefreshBtn" type="button" class="ghost goals-refresh-btn">↻ 更新</button>
    </div>`;

  if (!goals.length) {
    root.innerHTML = header + `
      <div class="goals-empty muted">
        今月の目標はありません。<br>
        「📋 作業一覧」タブ → タスク追加で <strong>種類: 目標</strong> を選んで追加してください。
      </div>`;
    root.querySelector('#goalsRefreshBtn')?.addEventListener('click', () => void loadGoalsView());
    return;
  }

  const cards = goals.map(g => {
    const logs = evalByGoal.get(g.id) ?? [];
    const due = g.due_at
      ? `<span class="goals-due">期限: ${g.due_at.slice(0, 10)}</span>`
      : '';
    const details = g.details
      ? `<div class="goals-details">${esc(g.details)}</div>`
      : '';
    return `
      <div class="goals-card">
        <div class="goals-card-head">
          <span class="goals-title">${esc(g.title)}</span>
          ${statusBadge(g.status)}
          ${due}
        </div>
        ${details}
        ${renderDotRow(logs)}
      </div>`;
  }).join('');

  root.innerHTML = header + `<div class="goals-list">${cards}</div>`;
  root.querySelector('#goalsRefreshBtn')?.addEventListener('click', () => void loadGoalsView());
}
