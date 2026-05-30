// カテゴリ / チャンネルの冪等自動生成。 有効化時に Memoria カテゴリと必要な
// チャンネルを作り、 id を app_settings に保存する。 Manage Channels 権限が必要。
// 既存チャンネルは触らず、 Memoria カテゴリ配下のみを管理する (Concordia の
// ensureDiscordLayout と同方針)。

import { ChannelType, type Guild } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';
import { discordSettings } from './settings.js';

type Db = BetterSqlite3.Database;

const CATEGORY_NAME = 'Memoria';

/** オプトアウトに連動して生成するチャンネル一覧。 capture/各機能が OFF なら作らない。 */
function desiredChannels(cfg: ReturnType<typeof discordSettings>): string[] {
  const out: string[] = ['activity']; // 集約ログは常設
  if (cfg.autoTask) out.push('task');
  if (cfg.autoMemo) out.push('memo');
  if (cfg.autoBookmark) out.push('bookmark');
  if (cfg.autoMeal) out.push('meal');
  if (cfg.autoRecommend) out.push('recommend');
  if (cfg.announce) out.push('announce');
  if (cfg.monitor) out.push('monitor'); // 状態カード (状態/締切/次通知)
  return out;
}

async function ensureCategory(guild: Guild, db: Db): Promise<string> {
  const s = getAppSettings(db);
  const cached = s['discord.category_id'];
  if (cached && guild.channels.cache.get(cached)?.type === ChannelType.GuildCategory) return cached;
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME,
  );
  const cat = existing ?? (await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory }));
  setAppSettings(db, { 'discord.category_id': cat.id });
  return cat.id;
}

async function ensureTextChannel(guild: Guild, db: Db, parentId: string, name: string): Promise<void> {
  const key = `discord.channel.${name}_id`;
  const s = getAppSettings(db);
  const cached = s[key];
  if (cached && guild.channels.cache.get(cached)?.type === ChannelType.GuildText) return;
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === name && c.parentId === parentId,
  );
  const ch = existing ?? (await guild.channels.create({ name, type: ChannelType.GuildText, parent: parentId }));
  setAppSettings(db, { [key]: ch.id });
}

/** カテゴリ + 必要チャンネルを冪等生成し、 id を永続化する。 best-effort。 */
export async function ensureDiscordLayout(guild: Guild, db: Db): Promise<void> {
  const cfg = discordSettings(db);
  const categoryId = await ensureCategory(guild, db);
  for (const name of desiredChannels(cfg)) {
    await ensureTextChannel(guild, db, categoryId, name);
  }
}

/** kind 名 (例 'activity') の channel id を返す。 未生成なら null。 */
export function channelIdFor(db: Db, name: string): string | null {
  return getAppSettings(db)[`discord.channel.${name}_id`] || null;
}
