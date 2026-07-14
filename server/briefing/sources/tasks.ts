// タスクソース。 todo / doing のタスクを「今日やること」 として要約する。
// 既存の朝リマインダー (lib/scheduler.ts) と同じ listTasks を使う。

import type BetterSqlite3 from 'better-sqlite3';
import type { SectionBlock } from '../types.js';
import { listTasks } from '../../db.js';

type Db = BetterSqlite3.Database;

const PREVIEW = 5;
const HEADING = '📋 今日のタスク';

export function buildTasksBlock(db: Db): SectionBlock {
  try {
    const tasks = [
      ...listTasks(db, { status: 'todo', limit: 20 }),
      ...listTasks(db, { status: 'doing', limit: 20 }),
    ];
    if (!tasks.length) {
      return { key: 'tasks', heading: HEADING, lines: ['✅ 未完了のタスクはありません'] };
    }
    const todo = tasks.filter((t) => t.status === 'todo').length;
    const doing = tasks.filter((t) => t.status === 'doing').length;
    const lines = [`todo ${todo} 件 / 進行中 ${doing} 件`];
    for (const t of tasks.slice(0, PREVIEW)) {
      lines.push(`・${t.title.slice(0, 50)}`);
    }
    if (tasks.length > PREVIEW) lines.push(`…他 ${tasks.length - PREVIEW} 件`);
    return { key: 'tasks', heading: HEADING, lines };
  } catch (e: unknown) {
    return { key: 'tasks', heading: HEADING, lines: [`⚠️ 取得失敗（${e instanceof Error ? e.message : String(e)}）`] };
  }
}
