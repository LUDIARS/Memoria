import { apiPostJson } from '../http.js';
import { formatSingleTaskCard } from '../notify/card.js';

export interface TaskInput {
  title: string;
  details?: string | null;
  dueAt?: string | null;
  category?: string | null;
}

export interface TaskCreateResult {
  ok: boolean;
  status: number;
  taskId: number | null;
  summary: string;
}

export async function createTaskDetailed(input: TaskInput): Promise<TaskCreateResult> {
  const res = await apiPostJson('/api/tasks', {
    title: input.title,
    details: input.details ?? '',
    kind: 'task',
    creator_type: 'ai',
    due_at: input.dueAt ?? null,
    category: input.category ?? null,
  });
  if (!res.ok) {
    return { ok: false, status: res.status, taskId: null, summary: `タスク作成失敗 (${res.status})` };
  }
  const json = await res.json().catch(() => ({})) as { task?: { id?: number } };
  return {
    ok: true,
    status: res.status,
    taskId: typeof json.task?.id === 'number' ? json.task.id : null,
    summary: formatSingleTaskCard({
      title: input.title,
      category: input.category,
      dueAt: input.dueAt,
      details: input.details,
    }),
  };
}

export async function createTask(input: TaskInput): Promise<string> {
  const r = await createTaskDetailed(input);
  return r.summary;
}

export async function createMemo(title: string, details = ''): Promise<string> {
  const res = await apiPostJson('/api/tasks', {
    title,
    details,
    kind: 'task',
    creator_type: 'ai',
    due_at: null,
    category: 'memo',
  });
  if (!res.ok) return `メモ作成失敗 (${res.status})`;
  return `メモ登録: ${title}`;
}
