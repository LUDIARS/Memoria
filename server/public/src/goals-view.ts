// 「目標」タブ。
//
// 主役 = 事業ライン別 private ロードマップ (/api/roadmaps) の今月進捗。
// 7 事業ライン (LUDELLUS / BACK-OFFICE / PERSONAL-AI / KUZU-SURVIVORS /
// MUSA / DX-WORKFLOW / SCHOOL-HUB) それぞれの構成リポ・現状・今月の目標 +
// 達成率を一覧する。 正本は LUDIARS_ROOT/roadmap-*/data/*.json。
//
// 従属 = 旧来の個別目標タスク (kind='goal') + 毎朝 7 時の評価ドット。 こちらは
// ロードマップの下に残し、 登録があるときだけ表示する。

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

interface RoadmapGoal { text: string; metric?: string; done: boolean | null }
interface RoadmapMonth {
  month: string; theme: string; created: string;
  achievement: number | null; evaluated: string | null;
  goals: RoadmapGoal[];
}
interface RoadmapMember {
  repo: string; role: string; importance: number;
  status: string; statusLabel?: string;
  completion: number | null; note?: string; lines?: string[];
}
interface ContractGrade {
  grade: string;
  summary: { violations: number; skipped: number };
  global: { grade: string; violations: number };
  generated: string;
}
interface RoadmapLine {
  repo: string;
  line: {
    id: string; code: string; title: string; subtitle: string;
    icon: string; accent: string; visibility: string;
    summary: string; status: string; updated: string;
  };
  members: RoadmapMember[];
  months: RoadmapMonth[];
  memberCount: number;
  coreCount: number;
  refMaturity: number | null;
  currentMonth: RoadmapMonth | null;
  goalDone: number;
  goalTotal: number;
  contract: ContractGrade | null;
}
interface RoadmapAggregate {
  generated: string;
  root: string;
  count: number;
  lines: RoadmapLine[];
  errors: Array<{ repo: string; message: string }>;
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

function stars(n: number): string {
  return '★★★☆☆'.slice(3 - n, 6 - n);
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

// ── ロードマップ (事業ライン進捗) ─────────────────────────────────────────────

function contractGradeBadge(c: ContractGrade | null): string {
  if (!c) return '';
  const cls = c.grade === 'A' ? 'rm-contract-a'
    : c.grade === 'B' ? 'rm-contract-b'
    : c.grade === 'C' ? 'rm-contract-c'
    : 'rm-contract-d';
  const v = c.summary.violations;
  const tip = `連結グレード ${c.grade} (違反 ${v} 件・${c.generated})`;
  return `<span class="rm-contract ${cls}" title="${esc(tip)}">連結 ${esc(c.grade)}</span>`;
}

function achBadge(month: RoadmapMonth | null): string {
  if (!month) return '';
  if (month.achievement == null) {
    return '<span class="rm-ach rm-ach-pending">月末評価待ち</span>';
  }
  const cls = month.achievement >= 80 ? 'rm-ach-good' : month.achievement >= 50 ? 'rm-ach-mid' : 'rm-ach-low';
  return `<span class="rm-ach ${cls}">達成率 ${month.achievement}%</span>`;
}

function renderRoadmapGoals(month: RoadmapMonth | null): string {
  if (!month || !month.goals.length) {
    return '<div class="rm-goal-empty muted">今月の目標は未設定 (前月末/月初に作成)</div>';
  }
  const items = month.goals.map(g => {
    const cls = g.done === true ? 'rm-goal-done' : g.done === false ? 'rm-goal-miss' : 'rm-goal-open';
    const metric = g.metric ? `<span class="rm-goal-metric">${esc(g.metric)}</span>` : '';
    return `<li class="${cls}"><span class="rm-goal-mark"></span><span class="rm-goal-text">${esc(g.text)}</span>${metric}</li>`;
  }).join('');
  return `<ul class="rm-goals">${items}</ul>`;
}

function renderMembers(members: RoadmapMember[]): string {
  const chips = members.map(m => {
    const mat = m.completion == null ? '' : ` <span class="rm-mem-mat">${m.completion}%</span>`;
    return `<span class="rm-mem rm-mem-i${m.importance}" title="${esc(m.role)}">${esc(m.repo)} <span class="rm-mem-star">${stars(m.importance)}</span>${mat}</span>`;
  }).join('');
  return `<div class="rm-members">${chips}</div>`;
}

function renderRoadmapLine(ln: RoadmapLine): string {
  const cur = ln.currentMonth;
  const prog = ln.goalTotal ? Math.round((ln.goalDone / ln.goalTotal) * 100) : 0;
  return `
    <div class="rm-line" style="--rm-accent:${esc(ln.line.accent)}">
      <div class="rm-line-head">
        <span class="rm-icon">${esc(ln.line.icon)}</span>
        <span class="rm-title">${esc(ln.line.title)}</span>
        <span class="rm-vis">${esc(ln.line.visibility)}</span>
        <span class="rm-sub muted">${esc(ln.line.subtitle)}</span>
        <span class="rm-maturity" title="構成リポの重み付き平均成熟度 (主観・参考値)">参考成熟度 ${ln.refMaturity == null ? '—' : ln.refMaturity + '%'}</span>
        ${contractGradeBadge(ln.contract)}
      </div>
      <div class="rm-month">
        <span class="rm-month-key">${cur ? esc(cur.month) : '—'}</span>
        <span class="rm-theme">${cur ? esc(cur.theme) : '計画未作成'}</span>
        ${achBadge(cur)}
        <span class="rm-goalprog muted">目標 ${ln.goalDone}/${ln.goalTotal}</span>
        <span class="rm-progbar"><span class="rm-progfill" style="width:${prog}%"></span></span>
      </div>
      ${renderRoadmapGoals(cur)}
      <details class="rm-detail">
        <summary>構成リポ ${ln.memberCount} (中核 ★★★ ${ln.coreCount}) ・現状</summary>
        <div class="rm-status muted">${esc(ln.line.status)}</div>
        ${renderMembers(ln.members)}
      </details>
    </div>`;
}

function renderRoadmapSection(agg: RoadmapAggregate | null, err: string | null): string {
  const head = '<div class="rm-section-head"><span class="rm-section-title">🗺 事業ロードマップ進捗</span>'
    + '<button id="goalsRefreshBtn" type="button" class="ghost goals-refresh-btn">↻ 更新</button></div>';
  if (err) {
    return head + `<div class="rm-error">ロードマップを読めません: ${esc(err)}<br>`
      + '<span class="muted">LUDIARS_ROOT 配下に roadmap-* リポが必要です (env LUDIARS_ROOT で上書き可)。</span></div>';
  }
  if (!agg || !agg.lines.length) {
    return head + '<div class="rm-empty muted">ロードマップ (roadmap-* リポ) がまだありません。</div>';
  }
  const totalDone = agg.lines.reduce((a, l) => a + l.goalDone, 0);
  const totalGoals = agg.lines.reduce((a, l) => a + l.goalTotal, 0);
  const summary = `<div class="rm-summary muted">${agg.count} 事業ライン ・ 今月の目標 ${totalDone}/${totalGoals} 達成 ・ 更新 ${esc(agg.generated)}</div>`;
  const errNote = agg.errors.length
    ? `<div class="rm-error muted">読み込みエラー ${agg.errors.length} 件: ${esc(agg.errors.map(e => e.repo).join(', '))}</div>`
    : '';
  const lines = agg.lines.map(renderRoadmapLine).join('');
  return head + summary + errNote + `<div class="rm-lines">${lines}</div>`;
}

// ── 旧来の個別目標タスク (従属表示) ───────────────────────────────────────────

function renderLegacyGoals(goals: GoalTask[], evalByGoal: Map<number, GoalEvalLog[]>): string {
  if (!goals.length) return ''; // 個別目標タスクが無ければセクションごと出さない
  const month = currentMonth();
  const header = `
    <div class="goals-header goals-legacy-head">
      <span class="goals-month-label">${monthLabel(month)}</span>
      <span class="goals-count muted">${goals.length} 件 (個別タスク)</span>
    </div>`;
  const cards = goals.map(g => {
    const logs = evalByGoal.get(g.id) ?? [];
    const due = g.due_at ? `<span class="goals-due">期限: ${g.due_at.slice(0, 10)}</span>` : '';
    const details = g.details ? `<div class="goals-details">${esc(g.details)}</div>` : '';
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
  return header + `<div class="goals-list">${cards}</div>`;
}

export async function loadGoalsView(): Promise<void> {
  const root = document.getElementById('goalsRoot');
  if (!root) return;

  root.innerHTML = '<div class="muted goals-loading">読み込み中…</div>';

  const month = currentMonth();
  const [roadmapRes, goalsRes, evalsRes] = await Promise.all([
    fetch('/api/roadmaps').catch(() => null),
    fetch('/api/tasks?kind=goal&limit=200').catch(() => null),
    fetch(`/api/goal-evals?month=${month}`).catch(() => null),
  ]);

  let agg: RoadmapAggregate | null = null;
  let roadmapErr: string | null = null;
  if (roadmapRes && roadmapRes.ok) {
    agg = await roadmapRes.json() as RoadmapAggregate;
  } else if (roadmapRes) {
    const body = await roadmapRes.json().catch(() => null) as { error?: string } | null;
    roadmapErr = body?.error ?? `HTTP ${roadmapRes.status}`;
  } else {
    roadmapErr = 'サーバに接続できません';
  }

  const goals: GoalTask[] = goalsRes && goalsRes.ok ? (await goalsRes.json() as GoalTask[]) : [];
  const evals: GoalEvalLog[] = evalsRes && evalsRes.ok ? (await evalsRes.json() as GoalEvalLog[]) : [];
  const evalByGoal = new Map<number, GoalEvalLog[]>();
  for (const e of evals) {
    if (!evalByGoal.has(e.goal_id)) evalByGoal.set(e.goal_id, []);
    evalByGoal.get(e.goal_id)!.push(e);
  }

  root.innerHTML = renderRoadmapSection(agg, roadmapErr) + renderLegacyGoals(goals, evalByGoal);
  root.querySelector('#goalsRefreshBtn')?.addEventListener('click', () => void loadGoalsView());
}
