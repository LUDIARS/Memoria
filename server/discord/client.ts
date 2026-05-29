// discord.js client の生成とライフサイクル。 ready 時にレイアウトを冪等生成し、
// capture を登録する。 Discord 障害は Memoria 本体を止めないよう全て best-effort。

import { Client, Events } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { DISCORD_INTENTS, DISCORD_PARTIALS } from './intents.js';
import { discordBotToken, discordSettings } from './settings.js';
import { registerCapture } from './activity-capture.js';
import { ensureDiscordLayout } from './layout.js';

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
    ensureDiscordLayout(guild, db).catch((e: unknown) => {
      console.warn(`[discord] layout 生成失敗: ${e instanceof Error ? e.message : String(e)}`);
    });
  });

  client.on(Events.Error, (e) => {
    console.warn(`[discord] client error: ${e.message}`);
  });

  registerCapture(client, db);

  try {
    await client.login(discordBotToken());
    return client;
  } catch (e: unknown) {
    console.error(`[discord] login 失敗: ${e instanceof Error ? e.message : String(e)}`);
    try { client.destroy(); } catch { /* swallow */ }
    return null;
  }
}
