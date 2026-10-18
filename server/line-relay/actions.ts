// LINE の会話が使う Memoria の操作。 タスク・日記は既存の正本 (タスク登録 / 日記メモ) をそのまま使い、 別のデータは持たない。

import type BetterSqlite3 from 'better-sqlite3';
import { registerTask } from '../shared/task-registration.js';
import { selectTasks } from '../shared/task-select.js';
import { appendDiaryLine } from '../shared/diary-append.js';

type Db = BetterSqlite3.Database;

export interface LineRelayActions {
  /** タスクを 1 件足す。 requestKey は確認待ち ID (Actio 側の重複防止キー)。 */
  createTask(input: { title: string; requestKey: string }, now: Date): Promise<{ title: string }>;
  /** 今日締切・期限切れの未完了タスク (期限が近い順)。 */
  listTodayTasks(now: Date): Promise<{ title: string }[]>;
  /** 今日の日記メモに 1 行足す (上書きしない)。 */
  appendDiary(text: string, now: Date): void;
}

export function memoriaLineRelayActions(db: Db): LineRelayActions {
  return {
    createTask: async ({ title, requestKey }, now) => registerTask(db, {
      source_ref: `line:${requestKey}`,
      title,
      details: '',
      status: 'todo',
      kind: 'task',
      creator_type: 'human',
      due_at: null,
      category: null,
    }, now),
    listTodayTasks: async (now) => selectTasks(db, { categories: ['all'], deadline: 'due_today_or_overdue' }, now),
    appendDiary: (text, now) => appendDiaryLine(db, text, now),
  };
}
