// スラッシュコマンド。 ready 時に guild に登録 (guild コマンドは即時反映)。
//   /recommend            — おすすめ生成 → 内容を投稿
//   /task <text> [due]    — タスク登録 (リマインダー付き)
//   /memo <text>          — メモ登録 (リマインダー無し)
//   /mmtask [query]       — タスク残作業検索 (引数なし=今日期限)

import { type Client, Events, type Guild, SlashCommandBuilder, MessageFlags } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { discordSettings } from './settings.js';
import { isSelf } from './user-map.js';
import { createTask, createMemo } from './actions/task.js';
import { runRecommend } from './actions/recommend.js';
import { startDailyTaskReview } from './notify/daily-review.js';
import { listTasks } from '../db.js';

type Db = BetterSqlite3.Database;

const COMMANDS = [
  new SlashCommandBuilder().setName('recommend').setDescription('おすすめを生成して投稿する'),
  new SlashCommandBuilder().setName('task').setDescription('タスクを登録 (リマインダー付き)')
    .addStringOption((o) => o.setName('text').setDescription('内容').setRequired(true))
    .addStringOption((o) => o.setName('due').setDescription('期日 (ISO8601)')),
  new SlashCommandBuilder().setName('memo').setDescription('メモを登録 (リマインダー無し)')
    .addStringOption((o) => o.setName('text').setDescription('内容').setRequired(true)),
  new SlashCommandBuilder().setName('task-review').setDescription('\u30bf\u30b9\u30af\u68da\u5378\u3057\u3092\u958b\u59cb\u3059\u308b'),
  new SlashCommandBuilder()
    .setName('mmtask')
    .setDescription('\u30bf\u30b9\u30af\u6b8b\u4f5c\u696d\u691c\u7d22 (\u5f15\u6570\u306a\u3057=\u4eca\u65e5\u671f\u9650)')
    .addStringOption((o) =>
      o.setName('query').setDescription('\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u30b3\u30fc\u30c9 / \u30ab\u30c6\u30b4\u30ea / \u30ad\u30fc\u30ef\u30fc\u30c9'),
    ),
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
        } else if (interaction.commandName === 'task-review') {
          if (!isSelf(cfg, interaction.user.id)) {
            await interaction.reply({ content: '\u3053\u306e\u64cd\u4f5c\u306f\u8a31\u53ef\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002', flags: MessageFlags.Ephemeral });
            return;
          }
          const result = await startDailyTaskReview(
            client,
            db,
            { categories: ['all'], deadline: 'due_today_or_overdue' },
            'task',
            new Date(),
            { force: true, channelId: interaction.channelId },
          );
          if (result.started) {
            await interaction.reply({ content: `\u30bf\u30b9\u30af\u68da\u5378\u3057\u3092\u958b\u59cb\u3057\u307e\u3057\u305f (${result.count} \u4ef6)\u3002`, flags: MessageFlags.Ephemeral });
          } else if (result.reason === 'already_running') {
            await interaction.reply({ content: `\u30bf\u30b9\u30af\u68da\u5378\u3057\u306f\u3059\u3067\u306b\u9032\u884c\u4e2d\u3067\u3059 (${result.count} \u4ef6\u6b8b\u308a)\u3002`, flags: MessageFlags.Ephemeral });
          } else if (result.reason === 'channel_missing') {
            await interaction.reply({ content: '\u3053\u306e\u30c1\u30e3\u30f3\u30cd\u30eb\u306b\u68da\u5378\u3057\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u9001\u4fe1\u3067\u304d\u307e\u305b\u3093\u3002', flags: MessageFlags.Ephemeral });
          } else {
            await interaction.reply({ content: '\u68da\u5378\u3057\u5bfe\u8c61\u306e\u30bf\u30b9\u30af\u306f\u3042\u308a\u307e\u305b\u3093\u3002', flags: MessageFlags.Ephemeral });
          }
        } else if (interaction.commandName === 'mmtask') {
          if (!isSelf(cfg, interaction.user.id)) {
            await interaction.reply({ content: 'この操作は許可されていません。', flags: MessageFlags.Ephemeral });
            return;
          }
          const query = interaction.options.getString('query');
          let rows = listTasks(db, { limit: 200 }).filter((t) => t.status !== 'done');

          let label: string;
          if (query) {
            const q = query.toLowerCase();
            rows = rows.filter((t) =>
              t.title.toLowerCase().includes(q)
              || (t.details ?? '').toLowerCase().includes(q)
              || (t.category ?? '').toLowerCase().includes(q),
            );
            label = `"${query}" の検索結果`;
          } else {
            const d = new Date();
            const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            rows = rows.filter((t) => t.due_at?.startsWith(today));
            label = `今日期限 (${today})`;
          }

          if (rows.length === 0) {
            await interaction.reply({ content: `(${label} — 該当タスクなし)`, flags: MessageFlags.Ephemeral });
            return;
          }

          const lines: string[] = [`**Memoria タスク — ${label}**\n`];
          for (const t of rows.slice(0, 20)) {
            const due = t.due_at ? ` 期日:${t.due_at.slice(0, 10)}` : '';
            const cate = t.category ? ` [${t.category}]` : '';
            const flag = t.status === 'doing' ? '▶' : '・';
            lines.push(`${flag} #${t.id}${cate} ${t.title}${due}`);
            if (t.details) {
              const d = t.details.replace(/\s+/g, ' ').trim();
              lines.push(`    ${d.slice(0, 100)}${d.length > 100 ? '…' : ''}`);
            }
          }
          if (rows.length > 20) lines.push(`\n…他 ${rows.length - 20} 件`);
          lines.push(`\n${rows.length} 件`);

          await interaction.reply({ content: lines.join('\n').slice(0, 2000), flags: MessageFlags.Ephemeral });
        }
      } catch {
        try { await interaction.reply({ content: '処理に失敗しました', flags: MessageFlags.Ephemeral }); } catch { /* swallow */ }
      }
    })();
  });
}
