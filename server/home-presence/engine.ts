// event → 該当 rule の選択 → 文面 → 送り先へ送信。

import type BetterSqlite3 from 'better-sqlite3';
import { selectTasks } from '../shared/task-select.js';
import { sendToDestinations, type SinkSendResult } from '../shared/notify-sink.js';
import { loadRules } from './config.js';
import { composePresenceMessage, shouldSend } from './message.js';
import type { PresenceEvent, PresenceRule } from './types.js';

type Db = BetterSqlite3.Database;

export interface RuleFireResult {
  ruleId: string;
  sent: boolean;
  taskCount: number;
  results: SinkSendResult[];
}

/**
 * rule を 1 件送る。 force=true (テスト送信) はタスク 0 件でも送る。
 * 送り先が無い rule は送らない。
 */
export async function fireRule(
  db: Db,
  rule: PresenceRule,
  event: PresenceEvent,
  opts: { force?: boolean; now?: Date } = {},
): Promise<RuleFireResult> {
  const tasks = rule.includeTasks ? await selectTasks(db, rule.filter, opts.now ?? new Date()) : [];
  if (!rule.destinations.length || (!opts.force && !shouldSend(rule, tasks.length))) {
    return { ruleId: rule.id, sent: false, taskCount: tasks.length, results: [] };
  }
  const text = composePresenceMessage(rule, event, tasks);
  const results = await sendToDestinations(rule.destinations, text);
  return { ruleId: rule.id, sent: results.some((r) => r.ok), taskCount: tasks.length, results };
}

/** event に反応する有効な rule をすべて送る。 1 件の失敗で他を止めない。 */
export async function dispatchEvent(db: Db, event: PresenceEvent): Promise<RuleFireResult[]> {
  const rules = loadRules(db).filter((r) => r.enabled && r.event === event);
  const out: RuleFireResult[] = [];
  for (const rule of rules) {
    try {
      const res = await fireRule(db, rule, event);
      for (const r of res.results.filter((x) => !x.ok)) {
        console.warn(`[home-presence] rule ${rule.id} → ${r.destination.kind}: ${r.reason ?? 'failed'}`);
      }
      out.push(res);
    } catch (e: unknown) {
      console.warn(`[home-presence] rule ${rule.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
