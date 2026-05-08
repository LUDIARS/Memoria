// task domain — tasks
// Spec: spec/db/task.md

export type TaskStatus = 'todo' | 'doing' | 'done';
export type TaskCreatorType = 'human' | 'ai';

export interface TaskRow {
  id: number;
  title: string;
  details: string | null;
  status: TaskStatus;
  creator_type: TaskCreatorType;
  due_at: string | null;       // UTC ISO or 'YYYY-MM-DDTHH:MM' (local)
  share_actio: 0 | 1;
  shared_at: string | null;
  shared_origin: string | null;
  /**
   * カテゴリは **カンマ区切りの複数値** ("開発, 学習")。
   * parser ヘルパーは server side / client side でそれぞれ用意。
   */
  category: string | null;
  created_at: string;
  updated_at: string;
}
