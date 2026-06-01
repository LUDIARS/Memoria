import type { TaskRow } from '../../db/types/task.js';
import { parseCategories } from './select.js';

function pad2(n: number): string { return String(n).padStart(2, '0'); }

export function formatDue(dueAt: string | null, now: Date = new Date()): string {
  if (!dueAt) return '';
  const d = new Date(dueAt);
  if (!Number.isFinite(d.getTime())) return '';
  const label = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const endToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const t = d.getTime();
  if (t < startToday) return `🔴 期限超過 ${label}`;
  if (t <= endToday) return `🟡 今日 ${label}`;
  return `期限 ${label}`;
}

export function formatTaskLine(task: TaskRow, now: Date = new Date()): string {
  const cats = parseCategories(task.category).filter((c) => c !== 'memo');
  const catTag = cats.length ? `[${cats.join('/')}] ` : '';
  const due = formatDue(task.due_at, now);
  const dueTag = due ? ` - ${due}` : '';
  return `・${catTag}${task.title.slice(0, 80)}${dueTag}`;
}

const DISCORD_LIMIT = 1900;

export function formatTaskListCard(heading: string, tasks: TaskRow[], now: Date = new Date()): string {
  const header = `🔔 **${heading}** (${tasks.length} 件)`;
  if (!tasks.length) return `${header}\n該当タスクはありません。`;
  const lines: string[] = [];
  let len = header.length;
  let shown = 0;
  for (const t of tasks) {
    const line = formatTaskLine(t, now);
    if (len + line.length + 1 > DISCORD_LIMIT - 120) break;
    lines.push(line);
    len += line.length + 1;
    shown += 1;
  }
  const more = tasks.length > shown ? `\n…他 ${tasks.length - shown} 件` : '';
  const hasDueNowOrOverdue = tasks.some((t) => {
    const d = formatDue(t.due_at, now);
    return d.startsWith('🔴') || d.startsWith('🟡');
  });
  const ask = hasDueNowOrOverdue
    ? '\n\n期限が今日または超過のタスクがあります。期限を延長しますか？'
    : '';
  return `${header}\n${lines.join('\n')}${more}${ask}`;
}

export function formatSingleTaskCard(input: {
  title: string;
  category?: string | null;
  dueAt?: string | null;
  details?: string | null;
}, now: Date = new Date()): string {
  const cats = parseCategories(input.category ?? null).filter((c) => c !== 'memo');
  const lines = [`📝 **タスク登録**: ${input.title.slice(0, 120)}`];
  if (cats.length) lines.push(`カテゴリ: ${cats.join(', ')}`);
  const due = formatDue(input.dueAt ?? null, now);
  if (due) lines.push(due);
  if (input.details && input.details.trim()) lines.push(`詳細: ${input.details.trim().slice(0, 200)}`);
  return lines.join('\n');
}
