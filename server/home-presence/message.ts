// 一言 + タスク一覧の文面 (純関数)。 LINE でも読めるよう Markdown は使わない。

import type { TaskRow } from '../db/types/task.js';
import { parseCategories } from '../shared/task-select.js';
import type { PresenceEvent, PresenceRule } from './types.js';

export const DEFAULT_MESSAGES: Record<PresenceEvent, string> = {
  approach: '🏠 家の近くに来たよね',
  arrive: '🏠 おかえり、家に着いたね',
  depart: '🚪 家出発したよね',
};

/** 文面に載せるタスクの上限 (LINE / Discord の上限より十分小さく保つ)。 */
const MAX_TASK_LINES = 20;

function taskLine(task: TaskRow): string {
  const cats = parseCategories(task.category).filter((c) => c !== 'memo');
  const tag = cats.length ? `[${cats.join('/')}] ` : '';
  return `・${tag}${task.title.slice(0, 80)}`;
}

export function composePresenceMessage(rule: PresenceRule, event: PresenceEvent, tasks: TaskRow[]): string {
  const head = rule.message || DEFAULT_MESSAGES[event];
  if (!rule.includeTasks) return head;
  if (!tasks.length) return `${head}\n(該当するタスクはありません)`;
  const shown = tasks.slice(0, MAX_TASK_LINES).map(taskLine);
  const more = tasks.length > MAX_TASK_LINES ? `\n…他 ${tasks.length - MAX_TASK_LINES} 件` : '';
  return `${head}\n${rule.name} (${tasks.length} 件)\n${shown.join('\n')}${more}`;
}

/** タスク 0 件のとき送るか。 タスクを添えない rule は一言だけなので常に送る。 */
export function shouldSend(rule: PresenceRule, taskCount: number): boolean {
  return !rule.includeTasks || taskCount > 0 || rule.sendWhenEmpty;
}
