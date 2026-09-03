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
import { startBookNotifyScheduler } from './notify/books.js';

type Db = BetterSqlite3.Database;
type ReadyTask = () => void | Promise<void>;

function errorMessage(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const details: string[] = [];
  if (e.name && e.name !== 'Error') details.push(e.name);
  if (e.message) details.push(e.message);
  const code = (e as { code?: unknown }).code;
  if (code) details.push(`code=${String(code)}`);
  const cause = (e as { cause?: unknown }).cause;
  if (cause) details.push(`cause=${cause instanceof Error ? errorMessage(cause) : String(cause)}`);
  return details.length > 0 ? details.join(' ') : String(e);
}

export function runReadyTask(label: string, task: ReadyTask): void {
  try {
    const result = task();
    if (result) {
      void Promise.resolve(result).catch((e: unknown) => {
        console.warn(`[discord] ${label} failed: ${errorMessage(e)}`);
      });
    }
  } catch (e: unknown) {
    console.warn(`[discord] ${label} failed: ${errorMessage(e)}`);
  }
}

/** Create and login a Discord client. Returns null on login failure. */
export async function createDiscordClient(db: Db): Promise<Client | null> {
  const client = new Client({ intents: DISCORD_INTENTS, partials: DISCORD_PARTIALS });

  client.once(Events.ClientReady, (c) => {
    try {
      console.log(`[discord] logged in as ${c.user.tag}`);
      const guildId = discordSettings(db).guildId;
      const guild = c.guilds.cache.get(guildId);
      if (!guild) {
        console.warn(`[discord] guild ${guildId} not found`);
        return;
      }
      runReadyTask('layout / slash registration', async () => {
        await ensureDiscordLayout(guild, db);
        await registerSlashCommands(guild);
      });

      runReadyTask('task-notify scheduler start', () => startNotifyScheduler(c, db));
      runReadyTask('monitor scheduler start', () => startMonitor(c, db));
      runReadyTask('news scheduler start', () => startNewsScheduler(c, db));
      runReadyTask('diary summary scheduler start', () => startDiarySummaryScheduler(c, db));
      runReadyTask('recommend scheduler start', () => startRecommendScheduler(c, db));
      runReadyTask('book notify scheduler start', () => startBookNotifyScheduler(c, db));
    } catch (e: unknown) {
      console.warn(`[discord] ready handler failed: ${errorMessage(e)}`);
    }
  });

  client.on(Events.Error, (e: unknown) => {
    console.warn(`[discord] client error: ${errorMessage(e)}`);
  });
  client.on(Events.ShardError, (e: unknown, shardId: number) => {
    console.warn(`[discord] shard ${shardId} error: ${errorMessage(e)}`);
  });
  client.on(Events.ShardDisconnect, (event, shardId) => {
    console.warn(`[discord] shard ${shardId} disconnected: code=${event.code} reason=${event.reason || ''}`);
  });
  client.on(Events.Warn, (message) => {
    console.warn(`[discord] warn: ${message}`);
  });

  registerCapture(client, db);
  registerRouter(client, db);
  registerDailyTaskReviewInteractions(client, db);
  registerInteractions(client, db);

  try {
    await client.login(discordBotToken(db));
    return client;
  } catch (e: unknown) {
    console.error(`[discord] login failed: ${errorMessage(e)}`);
    try { client.destroy(); } catch { /* swallow */ }
    return null;
  }
}
