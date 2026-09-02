// task-triage — 提示中バッチへの LLM 提案 (期限を置く / 閉じる / 期限なしのまま)。
// 提案は UI の入力欄を埋めるだけで、 適用は人の判断 (decide) を経る。
// Spec: spec/feature/task-triage.md §AI 提案

import { runLlm } from '../llm.js';
import type { TaskRow } from '../db/types/task.js';
import type { TaskTriageSuggestion } from './types.js';

const MAX_DUE_IN_DAYS = 90;

/** LLM 出力 (```json フェンス等) から JSON オブジェクトを抜き出す。 失敗時 null。 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(candidate);
  if (direct) return direct;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) return tryParse(candidate.slice(start, end + 1));
  return null;
}

function addDaysLocal(base: Date, days: number): string {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, 18, 0, 0, 0);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}T18:00`;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** LLM 出力を検証済みの提案配列に。 未知 id / 不正 action は捨てる。 純関数。 */
export function coerceSuggestions(
  obj: Record<string, unknown> | null,
  knownIds: Set<number>,
  now: Date,
): TaskTriageSuggestion[] {
  const out: TaskTriageSuggestion[] = [];
  if (!obj || !Array.isArray(obj.suggestions)) return out;
  const seen = new Set<number>();
  for (const item of obj.suggestions) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.task_id === 'number' ? o.task_id : NaN;
    if (!Number.isFinite(id) || !knownIds.has(id) || seen.has(id)) continue;
    const action = o.action === 'due' || o.action === 'done' || o.action === 'keep' ? o.action : null;
    const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
    if (!action || !reason) continue;
    seen.add(id);
    if (action === 'due') {
      const daysRaw = typeof o.due_in_days === 'number' ? Math.round(o.due_in_days) : NaN;
      const days = Number.isFinite(daysRaw) ? Math.min(MAX_DUE_IN_DAYS, Math.max(1, daysRaw)) : 7;
      out.push({ task_id: id, action, due_in_days: days, due_at: addDaysLocal(now, days), reason });
    } else {
      out.push({ task_id: id, action, reason });
    }
  }
  return out;
}

export function buildSuggestPrompt(tasks: TaskRow[], now: Date): string {
  const lines = tasks.map((t) => {
    const cat = (t.category ?? '').split(',')[0].trim() || '(未分類)';
    const detail = (t.details ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const created = t.created_at.slice(0, 10);
    return `- #${t.id} [${t.status}] (${cat}, 作成 ${created}) ${t.title}${detail ? ` — ${detail}` : ''}`;
  });
  return [
    `あなたはタスク管理の整理係だ。 今日は ${formatLocalDate(now)}。`,
    '以下は **期限が設定されていない** 未完タスクだ。 各タスクについて 1 つだけ判断を提案せよ。',
    '',
    '- due  : 期限を置くべき。 due_in_days (今日から何日後か、 1〜90) を添える。 近い作業ほど短く。',
    '- done : 文面から既に完了していそう (「マージ済」「反映済」等)。 これからやる作業が明確に残るなら出さない。',
    '- keep : 期限を置く意味が無い (いつかやる / 参考メモ / 長期の方針)。 期限なしのまま置く。',
    '',
    '迷ったら keep。 reason は 1 文で短く。',
    '',
    '## タスク一覧',
    ...lines,
    '',
    '## 出力形式 (厳守)',
    '次の JSON だけを返す (前後に説明文を付けない):',
    '{ "suggestions": [ { "task_id": 12, "action": "due", "due_in_days": 7, "reason": "PR 提出待ちで来週に片付く" },',
    '                   { "task_id": 15, "action": "keep", "reason": "参考メモで作業ではない" } ] }',
  ].join('\n');
}

export async function suggestForBatch(tasks: TaskRow[], now: Date = new Date()): Promise<TaskTriageSuggestion[]> {
  if (!tasks.length) return [];
  const raw = await runLlm({ task: 'task_triage', prompt: buildSuggestPrompt(tasks, now) });
  return coerceSuggestions(extractJsonObject(raw), new Set(tasks.map((t) => t.id)), now);
}
