// スラッシュコマンド。 ready 時に guild に登録 (guild コマンドは即時反映)。
//   /recommend            — おすすめ生成 → 内容を投稿
//   /task <text> [due]    — タスク登録 (リマインダー付き)
//   /memo <text>          — メモ登録 (リマインダー無し)

import { type Client, Events, type Guild, SlashCommandBuilder, MessageFlags } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { discordSettings } from './settings.js';
import { createTask, createMemo } from './actions/task.js';
import { runRecommend } from './actions/recommend.js';

type Db = BetterSqlite3.Database;

const COMMANDS = [
  new SlashCommandBuilder().setName('recommend').setDescription('おすすめを生成して投稿する'),
  new SlashCommandBuilder().setName('task').setDescription('タスクを登録 (リマインダー付き)')
    .addStringOption((o) => o.setName('text').setDescription('内容').setRequired(true))
    .addStringOption((o) => o.setName('due').setDescription('期日 (ISO8601)')),
  new SlashCommandBuilder().setName('memo').setDescription('メモを登録 (リマインダー無し)')
    .addStringOption((o) => o.setName('text').setDescription('内容').setRequired(true)),
].map((c) => c.toJSON());

export async function registerSlashCommands(guild: Guild): Promise<void> {
  await guild.commands.set(COMMANDS);
}

export function registerInteractions(client: Client, db: Db): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    void (async () => {
      const cfg = discordSettings(db);
      try {
        if (interaction.commandName === 'recommend') {
          if (!cfg.autoRecommend) { await interaction.reply({ content: 'おすすめは無効化されています', flags: MessageFlags.Ephemeral }); return; }
          await interaction.deferReply();
          await interaction.editReply(await runRecommend(db));
        } else if (interaction.commandName === 'task') {
          const text = interaction.options.getString('text', true);
          const due = interaction.options.getString('due');
          await interaction.reply(await createTask({ title: text, dueAt: due }));
        } else if (interaction.commandName === 'memo') {
          const text = interaction.options.getString('text', true);
          await interaction.reply(await createMemo(text));
        }
      } catch {
        try { await interaction.reply({ content: '処理に失敗しました', flags: MessageFlags.Ephemeral }); } catch { /* swallow */ }
      }
    })();
  });
}
