// 🔁 タスク確認キュー — 朝の Sonnet 棚卸し提案 (統合 cluster / 完了 completed) を
// 表示し、適用 / 却下 / いま棚卸し を扱う自己完結モジュール。
// app.ts からは loadTaskReviewView() を呼ぶだけ。state/DOM 内部には依存しない。
// Spec: spec/feature/task-review.md §UI

interface TaskSnapshotEntry { id: number; title: string; status: string; }
interface TaskReview {
  id: number;
  kind: 'cluster' | 'completed';
  project: string | null;
  task_ids: number[];
  primary_id: number | null;
  reason: string;
  snapshot: TaskSnapshotEntry[];
  status: string;
  for_date: string | null;
  created_at: string;
  applied_at: string | null;
}

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

/** POST して { status, body } を返す (409 conflict を呼び出し側で見分けるため status を渡す)。 */
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
export function setTaskReviewToast(fn: (msg: string) => void): void {
  if (typeof fn === 'function') toastFn = fn;
}

/** 適用/却下でタスクが変わったとき app.ts にタスク再読込を促すコールバック。 */
export function setTaskReviewOnChange(fn: () => void): void {
  if (typeof fn === 'function') onChangeFn = fn;
}

function toast(msg: string): void {
  try { toastFn(msg); } catch { /* noop */ }
}

function reviewCard(rv: TaskReview): string {
  const badge = rv.kind === 'cluster'
    ? '<span class="task-review-badge cluster">🧲 まとめる</span>'
    : '<span class="task-review-badge completed">✅ 完了確認</span>';
  const proj = rv.project ? `<span class="task-review-proj">${esc(rv.project)}</span>` : '';
  const items = rv.snapshot.map((s) => {
    const isPrimary = rv.kind === 'cluster' && s.id === rv.primary_id;
    return `<li class="${isPrimary ? 'is-primary' : ''}">`
      + `<span class="task-review-id">#${s.id}</span> ${esc(s.title)}`
      + `${isPrimary ? ' <span class="task-review-primary-tag">← 統合先</span>' : ''}</li>`;
  }).join('');
  return `
    <div class="task-review-card" data-review="${rv.id}">
      <div class="task-review-head">${badge}${proj}</div>
      <ul class="task-review-tasks">${items}</ul>
      <div class="task-review-reason muted">${esc(rv.reason)}</div>
      <div class="task-review-actions">
        <button class="primary" data-review-apply="${rv.id}">適用</button>
        <button class="ghost" data-review-dismiss="${rv.id}">却下</button>
      </div>
    </div>`;
}

/** app.ts の loadTasks() から board と一緒に呼ぶ。 */
export async function loadTaskReviewView(): Promise<void> {
  const root = document.getElementById('taskReviewPanel');
  if (!root) return;
  let items: TaskReview[] = [];
  try {
    const r = await getJson<{ items: TaskReview[] }>('/api/task-reviews?status=pending');
    items = r.items || [];
  } catch {
    items = [];
  }

  const header = `
    <div class="task-review-bar">
      <strong>🔁 タスク確認</strong>
      ${items.length ? `<span class="muted">${items.length} 件の提案</span>` : '<span class="muted">提案なし</span>'}
      <span class="grow"></span>
      <button class="ghost" id="taskReviewRunNow">いま棚卸し</button>
    </div>`;
  const body = items.length
    ? `<div class="task-review-list">${items.map(reviewCard).join('')}</div>`
    : '<div class="task-review-empty muted">近いタスクの統合候補・完了候補はいまありません。毎朝の棚卸しか「いま棚卸し」で生成されます。</div>';
  root.innerHTML = header + body;

  root.querySelector('#taskReviewRunNow')?.addEventListener('click', async () => {
    const btn = root.querySelector('#taskReviewRunNow') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = '棚卸し中…'; }
    try {
      const { status, body: b } = await postJson('/api/task-reviews/run-now', {});
      if (status >= 400) throw new Error((b as { error?: string }).error || `${status}`);
      const created = (b as { created?: number }).created ?? 0;
      toast(`タスク棚卸し完了: ${created} 件の提案`);
      await loadTaskReviewView();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'いま棚卸し'; }
      toast(`棚卸しに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  bindReviewActions(root);
}

function bindReviewActions(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('[data-review-apply]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.reviewApply);
      btn.disabled = true;
      btn.textContent = '適用中…';
      const { status, body } = await postJson(`/api/task-reviews/${id}/apply`);
      if (status === 409) {
        toast('タスクが変更されています。「いま棚卸し」で再解析してください。');
        await loadTaskReviewView();
        return;
      }
      if (status >= 400) {
        btn.disabled = false;
        btn.textContent = '適用';
        toast(`適用に失敗しました: ${(body as { error?: string }).error || status}`);
        return;
      }
      toast('提案を適用しました');
      onChangeFn();          // タスクが閉じた/統合された → board 再読込
      await loadTaskReviewView();
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-review-dismiss]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.reviewDismiss);
      btn.disabled = true;
      const { status } = await postJson(`/api/task-reviews/${id}/dismiss`);
      if (status >= 400) {
        btn.disabled = false;
        toast('却下に失敗しました');
        return;
      }
      root.querySelector(`[data-review="${id}"]`)?.remove();
    });
  });
}
