// discord.js client lifecycle. Discord failures are best-effort and must not
// stop the Memoria server.

import { Client, Events } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { DISCORD_INTENTS, DISCORD_PARTIALS } from './intents.js';
import { discordBotToken, discordSettings } from './settings.js';
import { registerCapture } from './activity-capture.js';
import { registerRouter } from './message-router.js';
import { registerInteractions, registerSlashCommands } from './slash-commands.js';
import { ensureDiscordLayout } from './layout.js';
import { startNotifyScheduler } from './notify/scheduler.js';
import { registerDailyTaskReviewInteractions } from './notify/daily-review.js';
import { startMonitor } from './monitor.js';
import { startNewsScheduler } from './news.js';
import { startDiarySummaryScheduler } from './diary-summary.js';
import { startRecommendScheduler } from './recommend-scheduler.js';

type Db = BetterSqlite3.Database;

/** Create and login a Discord client. Returns null on login failure. */
export async function createDiscordClient(db: Db): Promise<Client | null> {
  const client = new Client({ intents: DISCORD_INTENTS, partials: DISCORD_PARTIALS });

  client.once(Events.ClientReady, (c) => {
    console.log(`[discord] logged in as ${c.user.tag}`);
    const guildId = discordSettings(db).guildId;
    const guild = c.guilds.cache.get(guildId);
    if (!guild) {
      console.warn(`[discord] guild ${guildId} not found`);
      return;
    }
    ensureDiscordLayout(guild, db)
      .then(() => registerSlashCommands(guild))
      .catch((e: unknown) => {
        console.warn(`[discord] layout / slash registration failed: ${e instanceof Error ? e.message : String(e)}`);
      });

    startNotifyScheduler(c, db);
    startMonitor(c, db);
    startNewsScheduler(c, db);
    startDiarySummaryScheduler(c, db);
    startRecommendScheduler(c, db);
  });

  client.on(Events.Error, (e) => {
    console.warn(`[discord] client error: ${e.message}`);
  });

  registerCapture(client, db);
  registerRouter(client, db);
  registerDailyTaskReviewInteractions(client, db);
  registerInteractions(client, db);

  try {
    await client.login(discordBotToken(db));
    return client;
  } catch (e: unknown) {
    console.error(`[discord] login failed: ${e instanceof Error ? e.message : String(e)}`);
    try { client.destroy(); } catch { /* swallow */ }
    return null;
  }
}
