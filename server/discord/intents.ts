// Discord Gateway intents / partials.
//
// MESSAGE_CONTENT / GUILD_PRESENCES / GUILD_MEMBERS は Discord Developer Portal の
// "Privileged Gateway Intents" を ON にしていないと接続が拒否される (DisallowedIntents)。
// spec/feature/discord-bot.md の権限チェックリスト参照。

import { GatewayIntentBits, Partials } from 'discord.js';

/** 行動ログ取得 + 自動処理に必要な intent 一式。 */
export const DISCORD_INTENTS: GatewayIntentBits[] = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent, // privileged — 本文取得
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildPresences, // privileged — オンライン状態 / アクティビティ
  GatewayIntentBits.GuildMembers, // privileged — メンバー / ニックネーム
  GatewayIntentBits.GuildVoiceStates, // ボイス入退室
  GatewayIntentBits.DirectMessages,
];

/** リアクション等で uncached entity を扱うための partials。 */
export const DISCORD_PARTIALS: Partials[] = [
  Partials.Message,
  Partials.Channel,
  Partials.Reaction,
  Partials.User,
  Partials.GuildMember,
];
