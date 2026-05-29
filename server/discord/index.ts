// Discord Bot の起動/停止エントリ。 server/index.ts の listen 後に呼ぶ。
// enabled かつ token/self/guild が揃っているときだけ起動する。全て best-effort。

import type { Client } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { discordReady } from './settings.js';
import { createDiscordClient } from './client.js';

type Db = BetterSqlite3.Database;

let current: Client | null = null;

/** Discord Bot を起動する (条件を満たさなければ skip)。 */
export async function startDiscordBot(db: Db): Promise<void> {
  if (current) return; // 二重起動防止
  const ready = discordReady(db);
  if (!ready.ok) {
    console.log(`[discord] 起動 skip: ${ready.reason}`);
    return;
  }
  current = await createDiscordClient(db);
}

/** Discord Bot を停止する。 */
export function stopDiscordBot(): void {
  if (!current) return;
  try { current.destroy(); } catch { /* swallow */ }
  current = null;
}
