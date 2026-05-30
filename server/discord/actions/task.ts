// タスク / メモ作成。 既存 POST /api/tasks に委譲する。
// タスク = due_at 付き (= リマインダー対象)、 メモ = due_at 無し + category 'memo'。

import { apiPostJson } from '../http.js';
import { formatSingleTaskCard } from '../notify/card.js';

export interface TaskInput {
  title: string;
  details?: string | null;
  /** ISO 文字列。 指定時はリマインダー対象になる。 */
  dueAt?: string | null;
  /** カンマ区切りカテゴリ ("買い物, 開発")。 */
  category?: string | null;
}

/** タスク作成 (リマインダー付き)。 AI 解釈した内容を確認カードで返す。 */
export async function createTask(input: TaskInput): Promise<string> {
  const res = await apiPostJson('/api/tasks', {
    title: input.title,
    details: input.details ?? '',
    kind: 'task',
    creator_type: 'ai',
    due_at: input.dueAt ?? null,
    category: input.category ?? null,
  });
  if (!res.ok) return `タスク作成失敗 (${res.status})`;
  return formatSingleTaskCard({
    title: input.title,
    category: input.category,
    dueAt: input.dueAt,
    details: input.details,
  });
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
