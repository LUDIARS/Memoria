// トリガー発火: filter でタスク選択 → カード整形 → 指定 channel へ投稿。

import type { Client } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { postToChannel } from '../notifier.js';
import { selectTasks } from './select.js';
import { formatTaskListCard } from './card.js';
import type { NotifyTrigger } from './types.js';

type Db = BetterSqlite3.Database;

export interface FireResult {
  posted: boolean;
  count: number;
}

/**
 * トリガーを発火する。 該当タスクが 0 件のとき:
 *   - postWhenEmpty=false (定期実行): 何も送らない (通知過多を避ける)
 *   - postWhenEmpty=true  (手動テスト): 「該当なし」 を送って動作確認できる
 */
export async function fireTrigger(
  client: Client,
  db: Db,
  trigger: NotifyTrigger,
  opts: { postWhenEmpty?: boolean } = {},
): Promise<FireResult> {
  const tasks = selectTasks(db, trigger.filter);
  if (!tasks.length && !opts.postWhenEmpty) return { posted: false, count: 0 };
  const card = formatTaskListCard(trigger.name, tasks);
  await postToChannel(client, db, trigger.channel, card);
  return { posted: true, count: tasks.length };
}
