import {
  type Client, type Message, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { runLlm } from '../llm.js';
import { discordSettings, type DiscordSettings } from './settings.js';
import { isSelf } from './user-map.js';
import { createTaskDetailed, createMemo } from './actions/task.js';
import { createBookmark, extractFirstUrl } from './actions/bookmark.js';
import { createMeal } from './actions/meal.js';
import { runRecommend } from './actions/recommend.js';
import { getAppSettings } from '../db.js';
import { channelIdFor } from './layout.js';
import { apiPatchJson } from './http.js';
import {
  rememberTaskLink,
  findTaskByReplyMessageId,
  findTaskBySourceMessageId,
  forgetTaskLinkByTaskId,
} from './task-link.js';

type Db = BetterSqlite3.Database;
type Action = 'task' | 'memo' | 'bookmark' | 'meal' | 'recommend' | 'none';

interface DispatchResult {
  summary: string;
  taskId?: number | null;
}

function channelName(msg: Message): string {
  return 'name' in msg.channel && msg.channel.name ? msg.channel.name : '';
}

function parentCategoryId(msg: Message): string | null {
  return 'parentId' in msg.channel && typeof msg.channel.parentId === 'string'
    ? msg.channel.parentId
    : null;
}

function isMemoriaManagedChannel(db: Db, cfg: DiscordSettings, msg: Message): boolean {
  const settings = getAppSettings(db);
  const categoryId = settings['discord.category_id'] || '';
  if (!categoryId || parentCategoryId(msg) !== categoryId) return false;

  const allowed = new Set<string>();
  if (cfg.autoTask) {
    const id = channelIdFor(db, 'task');
    if (id) allowed.add(id);
  }
  if (cfg.autoMemo) {
    const id = channelIdFor(db, 'memo');
    if (id) allowed.add(id);
  }
  if (cfg.autoBookmark) {
    const id = channelIdFor(db, 'bookmark');
    if (id) allowed.add(id);
  }
  if (cfg.autoMeal) {
    const id = channelIdFor(db, 'meal');
    if (id) allowed.add(id);
  }
  if (cfg.autoRecommend) {
    const id = channelIdFor(db, 'recommend');
    if (id) allowed.add(id);
  }
  return allowed.has(msg.channelId);
}

interface Interpreted {
  action: Action;
  title?: string;
  category?: string | null;
  details?: string | null;
  dueAt?: string | null;
}

async function classify(text: string): Promise<Interpreted> {
  const prompt = `あなたはライフログ Bot のルーターです。次のメッセージを task/memo/bookmark/recommend のいずれかに分類し、JSON のみで答えてください。\n`
    + `task=締切のある予定/やること, memo=締切のないメモ, recommend=おすすめ要求, bookmark=保存したいURL。\n`
    + `task の場合は内容を解釈して title(簡潔な見出し) / category(下記ルール) / due_at(ISO8601 か null) / details(補足、無ければ空) を埋めること。\n`
    + `【カテゴリ命名ルール】`
    + ` (1)人間が手で行う確認・検証・チェック・レビュー作業は"確認作業"を必ず含める。`
    + ` (2)プロジェクト開発タスクはプロジェクト正式名をカテゴリにする`
    + ` (例: KuzuSurvivors / Tirocinium / Memoria / Discutere / Concordia 等。略称・「開発」接尾語は使わない)。`
    + ` (3)複数カテゴリはカンマ区切り。(4)上記に当てはまらなければ空。\n`
    + `形式: {"action":"task|memo|bookmark|recommend|none","title":"...","due_at":"ISO8601 or null","category":"...","details":"..."}\n\nメッセージ: ${text}`;
  try {
    const raw = await runLlm({ task: 'discord_route', prompt, timeoutMs: 30_000 });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { action: 'none' };
    const j = JSON.parse(m[0]) as { action?: string; title?: string; due_at?: string | null; category?: string | null; details?: string | null };
    const allowed: string[] = ['task', 'memo', 'bookmark', 'recommend'];
    const action: Action = allowed.includes(j.action ?? '') ? (j.action as Action) : 'none';
    return { action, title: j.title, dueAt: j.due_at ?? null, category: j.category ?? null, details: j.details ?? null };
  } catch {
    return { action: 'none' };
  }
}

function toTaskInput(text: string, r: Interpreted) {
  return { title: r.title || text, dueAt: r.dueAt, category: r.category, details: r.details };
}

async function markTaskDone(db: Db, taskId: number): Promise<boolean> {
  const res = await apiPatchJson(`/api/tasks/${taskId}`, { status: 'done' });
  return res.ok;
}

async function handleReplyCompletion(db: Db, cfg: DiscordSettings, msg: Message): Promise<boolean> {
  if (!cfg.autoTask) return false;
  const refId = msg.reference?.messageId;
  if (!refId) return false;
  const link = findTaskByReplyMessageId(db, refId);
  if (!link) return false;
  if (!await markTaskDone(db, link.taskId)) return false;
  await msg.channel.messages.fetch(link.sourceMessageId).then((m) => m.react('✅')).catch(() => {});
  if (link.replyMessageId) await msg.channel.messages.fetch(link.replyMessageId).then((m) => m.delete()).catch(() => {});
  forgetTaskLinkByTaskId(db, link.taskId);
  return true;
}

async function dispatch(db: Db, cfg: DiscordSettings, msg: Message): Promise<DispatchResult | null> {
  if (!isMemoriaManagedChannel(db, cfg, msg)) return null;

  const text = (msg.content ?? '').trim();
  const ch = channelName(msg);
  const image = msg.attachments.find((a) => (a.contentType ?? '').startsWith('image/'));
  const url = extractFirstUrl(text);

  if (ch === 'task' && cfg.autoTask) {
    if (!cfg.aiProcess || !text) {
      const r = await createTaskDetailed({ title: text });
      return { summary: r.summary, taskId: r.taskId };
    }
    const r = await createTaskDetailed(toTaskInput(text, await classify(text)));
    return { summary: r.summary, taskId: r.taskId };
  }
  if (ch === 'memo' && cfg.autoMemo) return { summary: await createMemo(text) };
  if (ch === 'bookmark' && cfg.autoBookmark && url) return { summary: await createBookmark(url) };
  if (ch === 'meal' && cfg.autoMeal && image) return { summary: await createMeal({ url: image.url, name: image.name, contentType: image.contentType }, text) };

  if (image && cfg.autoMeal) return { summary: await createMeal({ url: image.url, name: image.name, contentType: image.contentType }, text) };
  if (url && cfg.autoBookmark) return { summary: await createBookmark(url) };

  if (!cfg.aiProcess || !text) return null;
  const r = await classify(text);
  if (r.action === 'task' && cfg.autoTask) {
    const t = await createTaskDetailed(toTaskInput(text, r));
    return { summary: t.summary, taskId: t.taskId };
  }
  if (r.action === 'memo' && cfg.autoMemo) return { summary: await createMemo(r.title || text) };
  if (r.action === 'bookmark' && cfg.autoBookmark && url) return { summary: await createBookmark(url) };
  if (r.action === 'recommend' && cfg.autoRecommend) return { summary: await runRecommend(db) };
  return null;
}

export function registerRouter(client: Client, db: Db): void {
  client.on(Events.MessageCreate, (msg) => {
    const cfg = discordSettings(db);
    if (msg.author?.bot || !isSelf(cfg, msg.author?.id)) return;
    void (async () => {
      try {
        if (await handleReplyCompletion(db, cfg, msg)) return;
        const out = await dispatch(db, cfg, msg);
        if (!out) return;
        const reply = await msg.reply(
          out.taskId
            ? {
              content: out.summary,
              components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                  new ButtonBuilder()
                    .setCustomId(`memoria_task_done:${out.taskId}`)
                    .setLabel('完了')
                    .setStyle(ButtonStyle.Success),
                ),
              ],
            }
            : out.summary,
        ).catch(() => null);
        if (out.taskId) {
          rememberTaskLink(db, {
            taskId: out.taskId,
            sourceChannelId: msg.channelId,
            sourceMessageId: msg.id,
            replyMessageId: reply?.id ?? null,
            createdAt: new Date().toISOString(),
          });
        }
      } catch {
        // best-effort
      }
    })();
  });

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    const cfg = discordSettings(db);
    if (!isSelf(cfg, user.id)) return;
    const emoji = reaction.emoji.name ?? '';
    if (!['✅', '☑️', '✔️', 'white_check_mark'].includes(emoji)) return;
    void (async () => {
      try {
        const sourceId = reaction.message.id;
        const link = findTaskBySourceMessageId(db, sourceId);
        if (!link) return;
        if (!await markTaskDone(db, link.taskId)) return;
        await reaction.message.react('✅').catch(() => {});
        if (link.replyMessageId) await reaction.message.channel.messages.fetch(link.replyMessageId).then((m) => m.delete()).catch(() => {});
        forgetTaskLinkByTaskId(db, link.taskId);
      } catch {
        // best-effort
      }
    })();
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('memoria_task_done:')) return;
    const cfg = discordSettings(db);
    if (!isSelf(cfg, interaction.user.id)) {
      void interaction.reply({ content: 'この操作は許可されていません。', ephemeral: true }).catch(() => {});
      return;
    }
    void (async () => {
      try {
        const taskId = Number(interaction.customId.split(':')[1]);
        if (!Number.isFinite(taskId) || taskId <= 0) {
          await interaction.reply({ content: 'タスクIDが不正です。', ephemeral: true }).catch(() => {});
          return;
        }
        const link = findTaskByReplyMessageId(db, interaction.message.id);
        if (!link || link.taskId !== taskId) {
          await interaction.reply({ content: '対応するタスクが見つかりません。', ephemeral: true }).catch(() => {});
          return;
        }
        if (!await markTaskDone(db, taskId)) {
          await interaction.reply({ content: 'タスク完了に失敗しました。', ephemeral: true }).catch(() => {});
          return;
        }
        await interaction.channel?.messages.fetch(link.sourceMessageId).then((m) => m.react('✅')).catch(() => {});
        await interaction.update({ content: `${interaction.message.content}\n\n✅ 完了にしました`, components: [] }).catch(() => {});
        await interaction.message.delete().catch(() => {});
        forgetTaskLinkByTaskId(db, taskId);
      } catch {
        await interaction.reply({ content: '処理に失敗しました。', ephemeral: true }).catch(() => {});
      }
    })();
  });
}
