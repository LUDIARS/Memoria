// タスク / メモ作成。 既存 POST /api/tasks に委譲する。
// タスク = due_at 付き (= リマインダー対象)、 メモ = due_at 無し + category 'memo'。

import { apiPostJson } from '../http.js';

export interface TaskInput {
  title: string;
  details?: string;
  /** ISO 文字列。 指定時はリマインダー対象になる。 */
  dueAt?: string | null;
}

/** タスク作成 (リマインダー付き)。 結果サマリ文字列を返す。 */
export async function createTask(input: TaskInput): Promise<string> {
  const res = await apiPostJson('/api/tasks', {
    title: input.title,
    details: input.details ?? '',
    kind: 'task',
    creator_type: 'ai',
    due_at: input.dueAt ?? null,
  });
  if (!res.ok) return `タスク作成失敗 (${res.status})`;
  return input.dueAt ? `タスク登録: ${input.title} (期日 ${input.dueAt})` : `タスク登録: ${input.title}`;
}

/** メモ作成 (リマインダー無し)。 */
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
