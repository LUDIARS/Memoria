// 📅 期限未設定タスクの棚卸しセッション — 期限が無い未完タスクを 10 件ずつ提示し、
// 1 件ずつ「期限を置く / 完了 / 期限なしのまま / あとで」を判断していく自己完結モジュール。
// AI 提案 (Sonnet) は入力欄を埋めるだけで、 適用は必ず人のクリックを経る。
// app.ts からは loadTaskTriageView() を呼ぶだけ。state/DOM 内部には依存しない。
// Spec: spec/feature/task-triage.md §UI

interface TaskRowLite {
  id: number;
  title: string;
  details: string | null;
  status: string;
  category: string | null;
  created_at: string;
}
type DecisionKind = 'due' | 'done' | 'keep' | 'later';
interface Progress {
  total: number; decided: number; deferred: number; remaining: number;
  counts: Record<DecisionKind, number>;
}
interface TriageSession { id: number; status: 'active' | 'finished'; task_ids: number[]; created_at: string; }
interface TriageState { session: TriageSession; progress: Progress; batch: TaskRowLite[]; }
interface Suggestion { task_id: number; action: 'due' | 'done' | 'keep'; due_in_days?: number; due_at?: string; reason: string; }

const BATCH = 10;

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson(url: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body: parsed };
}

let toastFn: (msg: string) => void = (msg) => { console.log(msg); };
let onChangeFn: () => void = () => { /* noop */ };

/** app.ts の flashToast を注入。 */
export function setTaskTriageToast(fn: (msg: string) => void): void {
  if (typeof fn === 'function') toastFn = fn;
}
/** 判断でタスクが変わったとき app.ts にタスク再読込を促すコールバック。 */
export function setTaskTriageOnChange(fn: () => void): void {
  if (typeof fn === 'function') onChangeFn = fn;
}
function toast(msg: string): void {
  try { toastFn(msg); } catch { /* noop */ }
}

// 直近の提案 (task_id → suggestion)。 再描画しても保持する。
let suggestions = new Map<number, Suggestion>();
// 再入防止: loadTasks() 経由の再描画中にセッション状態を二重取得しない。
let rendering = false;

function suggestionLine(s: Suggestion | undefined): string {
  if (!s) return '';
  const label = s.action === 'due' ? `📅 ${s.due_in_days ?? ''} 日後に期限`
    : s.action === 'done' ? '✅ 完了扱い' : '📌 期限なしのまま';
  return `<div class="task-triage-suggest" data-suggest-action="${s.action}">`
    + `<span class="task-triage-suggest-label">AI 提案: ${esc(label)}</span> <span class="muted">${esc(s.reason)}</span></div>`;
}

function taskCard(t: TaskRowLite): string {
  const cat = (t.category ?? '').split(',')[0].trim();
  const detail = (t.details ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const s = suggestions.get(t.id);
  const prefill = s?.action === 'due' && s.due_at ? s.due_at.slice(0, 10) : '';
  return `
    <div class="task-triage-card foundation-form" data-triage-task="${t.id}">
      <div class="task-triage-head">
        <span class="task-review-id">#${t.id}</span>
        ${cat ? `<span class="task-review-proj">${esc(cat)}</span>` : ''}
        <span class="muted task-triage-created">作成 ${esc(t.created_at.slice(0, 10))}</span>
        <span class="grow"></span>
        <span class="task-triage-status">${esc(t.status)}</span>
      </div>
      <div class="task-triage-title">${esc(t.title)}</div>
      ${detail ? `<div class="task-triage-detail muted">${esc(detail)}</div>` : ''}
      ${suggestionLine(s)}
      <div class="task-triage-actions">
        <input type="date" class="task-triage-due" value="${esc(prefill)}" aria-label="期限" />
        <button class="primary" data-triage-decide="due">期限を置く</button>
        <button data-triage-decide="done">完了</button>
        <button class="ghost" data-triage-decide="keep">期限なしのまま</button>
        <button class="ghost" data-triage-decide="later">あとで</button>
      </div>
    </div>`;
}

function progressBar(p: Progress): string {
  const pct = p.total ? Math.round((p.decided / p.total) * 100) : 100;
  return `
    <div class="task-triage-progress">
      <div class="task-triage-progress-bar"><div class="task-triage-progress-fill" style="width:${pct}%"></div></div>
      <span class="muted">${p.decided} / ${p.total} 判断済 (残 ${p.remaining}${p.deferred ? `、 後回し ${p.deferred}` : ''})
        · 期限 ${p.counts.due} · 完了 ${p.counts.done} · 据え置き ${p.counts.keep}</span>
    </div>`;
}

function renderIdle(root: HTMLElement, undatedTotal: number): void {
  root.innerHTML = `
    <div class="task-review-bar">
      <strong>📅 期限未設定の棚卸し</strong>
      <span class="muted">${undatedTotal ? `${undatedTotal} 件が期限なし` : '期限なしのタスクはありません'}</span>
      <span class="grow"></span>
      ${undatedTotal ? '<button class="ghost" id="taskTriageStart">セッション開始</button>' : ''}
    </div>`;
  root.querySelector('#taskTriageStart')?.addEventListener('click', async () => {
    const { status, body } = await postJson('/api/task-triage/session', { batch: BATCH });
    if (status >= 400) { toast('セッションを開始できませんでした'); return; }
    suggestions = new Map();
    renderSession(root, (body as { state: TriageState }).state);
  });
}

function renderSession(root: HTMLElement, state: TriageState): void {
  const { session, progress, batch } = state;
  const header = `
    <div class="task-review-bar">
      <strong>📅 期限未設定の棚卸し</strong>
      <span class="muted">セッション #${session.id}</span>
      <span class="grow"></span>
      <button class="ghost" id="taskTriageSuggest" ${batch.length ? '' : 'disabled'}>AI 提案</button>
      <button class="ghost" id="taskTriageRestart" title="いまの期限なしタスクを集め直して新しいセッションにする">集め直す</button>
      <button id="taskTriageFinish">セッション終了</button>
    </div>
    ${progressBar(progress)}`;
  const body = batch.length
    ? `<div class="task-review-list">${batch.map(taskCard).join('')}</div>`
    : '<div class="task-review-empty muted">このセッションの期限なしタスクはすべて判断済みです。「セッション終了」で閉じてください。</div>';
  root.innerHTML = header + body;

  root.querySelector('#taskTriageSuggest')?.addEventListener('click', async () => {
    const btn = root.querySelector('#taskTriageSuggest') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = '提案中…'; }
    const { status, body: b } = await postJson(`/api/task-triage/session/${session.id}/suggest`, { batch: BATCH });
    if (status >= 400) {
      if (btn) { btn.disabled = false; btn.textContent = 'AI 提案'; }
      toast(`提案に失敗しました: ${(b as { error?: string }).error || status}`);
      return;
    }
    for (const s of (b as { suggestions: Suggestion[] }).suggestions || []) suggestions.set(s.task_id, s);
    renderSession(root, state);
  });

  root.querySelector('#taskTriageRestart')?.addEventListener('click', async () => {
    const { status, body: b } = await postJson('/api/task-triage/session', { restart: true, batch: BATCH });
    if (status >= 400) { toast('集め直しに失敗しました'); return; }
    suggestions = new Map();
    renderSession(root, (b as { state: TriageState }).state);
  });

  root.querySelector('#taskTriageFinish')?.addEventListener('click', async () => {
    const { status, body: b } = await postJson(`/api/task-triage/session/${session.id}/finish`);
    if (status >= 400) { toast('終了に失敗しました'); return; }
    const p = (b as { state: TriageState }).state.progress;
    toast(`棚卸しセッション終了: 期限 ${p.counts.due} · 完了 ${p.counts.done} · 据え置き ${p.counts.keep} · 残 ${p.remaining}`);
    suggestions = new Map();
    await loadTaskTriageView();
  });

  bindDecisions(root, session.id);
}

function bindDecisions(root: HTMLElement, sessionId: number): void {
  root.querySelectorAll<HTMLElement>('[data-triage-task]').forEach((card) => {
    const taskId = Number(card.dataset.triageTask);
    card.querySelectorAll<HTMLButtonElement>('[data-triage-decide]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const decision = btn.dataset.triageDecide as DecisionKind;
        const dueInput = card.querySelector<HTMLInputElement>('.task-triage-due');
        const dueAt = decision === 'due' ? (dueInput?.value || '') : undefined;
        if (decision === 'due' && !dueAt) { toast('期限の日付を入れてください'); dueInput?.focus(); return; }
        card.querySelectorAll('button').forEach((b) => { (b as HTMLButtonElement).disabled = true; });
        const { status, body } = await postJson(`/api/task-triage/session/${sessionId}/decide`, {
          task_id: taskId, decision, due_at: dueAt, batch: BATCH,
        });
        if (status >= 400) {
          card.querySelectorAll('button').forEach((b) => { (b as HTMLButtonElement).disabled = false; });
          toast(`判断を保存できませんでした: ${(body as { error?: string }).error || status}`);
          return;
        }
        suggestions.delete(taskId);
        if (decision === 'due' || decision === 'done') onChangeFn();   // タスク本体が変わった → board 再読込
        renderSession(root, (body as { state: TriageState }).state);
      });
    });
  });
}

/** app.ts の loadTasks() から board と一緒に呼ぶ。 active セッションがあれば再開表示。 */
export async function loadTaskTriageView(): Promise<void> {
  const root = document.getElementById('taskTriagePanel');
  if (!root || rendering) return;
  rendering = true;
  try {
    const r = await getJson<{ state: TriageState | null; undated_total: number }>(`/api/task-triage/session?batch=${BATCH}`);
    if (r.state) renderSession(root, r.state);
    else renderIdle(root, r.undated_total ?? 0);
  } catch {
    root.innerHTML = '';
  } finally {
    rendering = false;
  }
}
