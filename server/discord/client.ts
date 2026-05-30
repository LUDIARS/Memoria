// discord.js client の生成とライフサイクル。 ready 時にレイアウトを冪等生成し、
// capture を登録する。 Discord 障害は Memoria 本体を止めないよう全て best-effort。

import { Client, Events } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { DISCORD_INTENTS, DISCORD_PARTIALS } from './intents.js';
import { discordBotToken, discordSettings } from './settings.js';
import { registerCapture } from './activity-capture.js';
import { registerRouter } from './message-router.js';
import { registerInteractions, registerSlashCommands } from './slash-commands.js';
import { ensureDiscordLayout } from './layout.js';
import { startNotifyScheduler } from './notify/scheduler.js';
import { startMonitor } from './monitor.js';

type Db = BetterSqlite3.Database;

/** login 済みの client を生成して返す。 失敗時は null (本体は継続)。 */
export async function createDiscordClient(db: Db): Promise<Client | null> {
  const client = new Client({ intents: DISCORD_INTENTS, partials: DISCORD_PARTIALS });

  client.once(Events.ClientReady, (c) => {
    console.log(`[discord] logged in as ${c.user.tag}`);
    const guildId = discordSettings(db).guildId;
    const guild = c.guilds.cache.get(guildId);
    if (!guild) {
      console.warn(`[discord] guild ${guildId} not found (Bot が招待されていない可能性)`);
      return;
    }
    ensureDiscordLayout(guild, db)
      .then(() => registerSlashCommands(guild))
      .catch((e: unknown) => {
        console.warn(`[discord] layout / slash 登録失敗: ${e instanceof Error ? e.message : String(e)}`);
      });
    // タスク通知エンジン (時刻 / GPS / ランダム トリガー) を起動。
    startNotifyScheduler(c, db);
    // monitor 状態カード (状態 / 今日の締切 / 次の通知) を起動。
    startMonitor(c, db);
  });

  client.on(Events.Error, (e) => {
    console.warn(`[discord] client error: ${e.message}`);
  });

  registerCapture(client, db);
  registerRouter(client, db);
  registerInteractions(client, db);

  try {
    await client.login(discordBotToken(db));
    return client;
  } catch (e: unknown) {
    console.error(`[discord] login 失敗: ${e instanceof Error ? e.message : String(e)}`);
    try { client.destroy(); } catch { /* swallow */ }
    return null;
  }
}
