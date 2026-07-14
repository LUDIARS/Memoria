import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type ButtonInteraction,
  type Client,
} from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, getTask, listTasks, setAppSettings, updateTask } from '../../db.js';
import type { TaskRow } from '../../db/types/task.js';
import { formatLocalDate } from '../../diary.js';
import { channelIdFor } from '../layout.js';
import { selfMention } from '../notifier.js';
import { discordSettings } from '../settings.js';
import { isSelf } from '../user-map.js';
import { formatTaskLine } from './card.js';
import { matchCategory } from './select.js';
import type { NotifyFilter } from './types.js';

type Db = BetterSqlite3.Database;

const STATE_KEY = 'features.discord.notify.daily_task_review';
const CUSTOM_ID_PREFIX = 'memoria_task_review:';

type ReviewBucket = 'overdue' | 'unscheduled';
type ReviewChoice = 'done' | 'today' | 'tomorrow' | 'week' | 'unset';

interface ReviewItem {
  taskId: number;
  bucket: ReviewBucket;
}

interface ReviewState {
  sessionId: string;
  date: string;
  channelKind: string;
  channelId?: string | null;
  pending: ReviewItem[];
  current?: ReviewItem | null;
  messageId?: string | null;
  done: number;
}

export interface StartDailyTaskReviewResult {
  started: boolean;
  count: number;
  reason?: 'already_running' | 'empty' | 'channel_missing';
}

function loadState(db: Db): ReviewState | null {
  const raw = getAppSettings(db)[STATE_KEY];
  if (!raw) return null;
  try {
    const state = JSON.parse(raw) as ReviewState;
    if (typeof state?.sessionId === 'string' && Array.isArray(state.pending)) return state;
  } catch {
    // ignore invalid persisted state
  }
  return null;
}

function saveState(db: Db, state: ReviewState): void {
  setAppSettings(db, { [STATE_KEY]: JSON.stringify(state) });
}

function saveCompletedState(db: Db, today: string, channelKind: string, channelId?: string | null): void {
  saveState(db, {
    sessionId: `done-${today}`,
    date: today,
    channelKind,
    channelId: channelId ?? null,
    pending: [],
    current: null,
    messageId: null,
    done: 0,
  });
}

function activeTasks(db: Db): TaskRow[] {
  return [
    ...listTasks(db, { status: 'todo', kind: 'task', limit: 500 }),
    ...listTasks(db, { status: 'doing', kind: 'task', limit: 500 }),
  ];
}

function startOfTodayMs(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
}

function selectReviewItems(db: Db, filter: NotifyFilter, now: Date): ReviewItem[] {
  const tasks = activeTasks(db).filter((task) => matchCategory(task, filter.categories));
  const overdue: ReviewItem[] = [];
  const unscheduled: ReviewItem[] = [];
  const start = startOfTodayMs(now);

  for (const task of tasks) {
    if (!task.due_at) {
      unscheduled.push({ taskId: task.id, bucket: 'unscheduled' });
      continue;
    }
    const due = new Date(task.due_at).getTime();
    if (Number.isFinite(due) && due < start) overdue.push({ taskId: task.id, bucket: 'overdue' });
  }
  return [...overdue, ...unscheduled];
}

function localDueAt(daysFromToday: number, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromToday, 23, 59, 0, 0);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}T23:59`;
}

function dueAtForChoice(choice: ReviewChoice): string | undefined {
  if (choice === 'today') return localDueAt(0);
  if (choice === 'tomorrow') return localDueAt(1);
  if (choice === 'week') return localDueAt(7);
  return undefined;
}

function bucketLabel(bucket: ReviewBucket): string {
  return bucket === 'overdue'
    ? '\u671f\u9650\u8d85\u904e\u30bf\u30b9\u30af'
    : '\u671f\u9650\u672a\u8a2d\u5b9a\u30bf\u30b9\u30af';
}

function reviewPrompt(db: Db, task: TaskRow, state: ReviewState): string {
  const mention = selfMention(db);
  const remainingIncludingCurrent = state.pending.length + 1;
  const total = state.done + remainingIncludingCurrent;
  const prefix = mention ? `${mention} ` : '';
  return [
    `${prefix}**${bucketLabel(state.current?.bucket ?? 'unscheduled')}** \u306e\u78ba\u8a8d (${state.done + 1}/${total})`,
    formatTaskLine(task),
    '',
    '\u3044\u3064\u3084\u308a\u307e\u3059\u304b\uff1f',
  ].join('\n');
}

function reviewComponents(state: ReviewState, taskId: number) {
  const base = `${CUSTOM_ID_PREFIX}${state.sessionId}:${taskId}`;
  const btn = (choice: ReviewChoice, label: string, style: ButtonStyle) =>
    new ButtonBuilder().setCustomId(`${base}:${choice}`).setLabel(label).setStyle(style);
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      btn('done', '\u5b8c\u4e86', ButtonStyle.Success),
      btn('today', '\u4eca\u65e5', ButtonStyle.Primary),
      btn('tomorrow', '\u660e\u65e5', ButtonStyle.Primary),
      btn('week', '\u6765\u9031', ButtonStyle.Secondary),
      btn('unset', '\u672a\u5b9a', ButtonStyle.Secondary),
    ),
  ];
}

async function fetchReviewChannel(client: Client, db: Db, channelKind: string) {
  const id = channelKind.startsWith('id:')
    ? channelKind.slice(3)
    : channelIdFor(db, channelKind);
  if (!id) return null;
  const ch = await client.channels.fetch(id).catch(() => null);
  return ch && ch.type === ChannelType.GuildText ? ch : null;
}

async function postNext(client: Client, db: Db, state: ReviewState): Promise<void> {
  const next = state.pending.shift();
  if (!next) {
    saveState(db, { ...state, current: null, messageId: null });
    return;
  }

  const task = getTask(db, next.taskId);
  if (!task || task.status === 'done') {
    state.done += 1;
    saveState(db, state);
    await postNext(client, db, state);
    return;
  }

  state.current = next;
  const ch = await fetchReviewChannel(client, db, state.channelKind);
  if (!ch) {
    saveState(db, state);
    return;
  }
  const msg = await ch.send({ content: reviewPrompt(db, task, state), components: reviewComponents(state, task.id) });
  state.messageId = msg.id;
  saveState(db, state);
}

export async function startDailyTaskReview(
  client: Client,
  db: Db,
  filter: NotifyFilter,
  channelKind: string,
  now: Date = new Date(),
  opts: { force?: boolean; channelId?: string | null } = {},
): Promise<StartDailyTaskReviewResult> {
  const today = formatLocalDate(now);
  const current = loadState(db);
  if (current?.date === today && (current.current || current.pending.length)) {
    return { started: false, count: current.pending.length + (current.current ? 1 : 0), reason: 'already_running' };
  }
  if (current?.date === today && !opts.force) {
    return { started: false, count: current.pending.length + (current.current ? 1 : 0), reason: 'already_running' };
  }

  const pending = selectReviewItems(db, filter, now);
  if (!pending.length) {
    saveCompletedState(db, today, channelKind, opts.channelId ?? null);
    return { started: false, count: 0, reason: 'empty' };
  }
  const count = pending.length;
  const stateChannelKind = opts.channelId ? `id:${opts.channelId}` : channelKind;
  if (!await fetchReviewChannel(client, db, stateChannelKind)) {
    return { started: false, count, reason: 'channel_missing' };
  }

  const state: ReviewState = {
    sessionId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    date: today,
    channelKind: stateChannelKind,
    channelId: opts.channelId ?? null,
    pending,
    current: null,
    messageId: null,
    done: 0,
  };
  saveState(db, state);
  await postNext(client, db, state);
  return { started: true, count };
}

export function registerDailyTaskReviewInteractions(client: Client, db: Db): void {
  client.on('interactionCreate', (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith(CUSTOM_ID_PREFIX)) return;

    const cfg = discordSettings(db);
    if (!isSelf(cfg, interaction.user.id)) {
      void interaction.reply({ content: '\u3053\u306e\u64cd\u4f5c\u306f\u8a31\u53ef\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002', ephemeral: true }).catch(() => {});
      return;
    }

    void handleReviewInteraction(client, db, interaction);
  });
}

async function handleReviewInteraction(client: Client, db: Db, interaction: ButtonInteraction): Promise<void> {
  const [, sessionId, taskIdRaw, choiceRaw] = interaction.customId.split(':');
  const taskId = Number(taskIdRaw);
  const choice = choiceRaw as ReviewChoice | undefined;
  const state = loadState(db);

  if (!state || state.sessionId !== sessionId || !state.current || state.current.taskId !== taskId || !choice) {
    await interaction.reply({ content: '\u3053\u306e\u78ba\u8a8d\u306f\u3059\u3067\u306b\u51e6\u7406\u6e08\u307f\u3067\u3059\u3002', ephemeral: true }).catch(() => {});
    return;
  }

  const task = getTask(db, taskId);
  if (task) {
    if (choice === 'done') {
      updateTask(db, taskId, { status: 'done' });
    } else {
      const dueAt = dueAtForChoice(choice);
      if (typeof dueAt === 'string') updateTask(db, taskId, { due_at: dueAt });
    }
  }

  state.done += 1;
  state.current = null;
  state.messageId = null;
  await interaction.deferUpdate().catch(() => {});
  await interaction.message.delete().catch(() => {});
  saveState(db, state);
  await postNext(client, db, state);
}
