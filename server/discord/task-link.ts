import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';

type Db = BetterSqlite3.Database;

const KEY = 'features.discord.task_links';

export interface DiscordTaskLink {
  taskId: number;
  sourceChannelId: string;
  sourceMessageId: string;
  replyMessageId: string | null;
  createdAt: string;
}

function loadAll(db: Db): DiscordTaskLink[] {
  const raw = getAppSettings(db)[KEY];
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is DiscordTaskLink => !!x && typeof x === 'object')
      .map((x) => ({
        taskId: Number(x.taskId),
        sourceChannelId: String(x.sourceChannelId ?? ''),
        sourceMessageId: String(x.sourceMessageId ?? ''),
        replyMessageId: x.replyMessageId ? String(x.replyMessageId) : null,
        createdAt: String(x.createdAt ?? new Date().toISOString()),
      }))
      .filter((x) => Number.isFinite(x.taskId) && x.taskId > 0 && x.sourceMessageId && x.sourceChannelId);
  } catch {
    return [];
  }
}

function saveAll(db: Db, items: DiscordTaskLink[]): void {
  const compact = items.slice(-1000);
  setAppSettings(db, { [KEY]: JSON.stringify(compact) });
}

export function rememberTaskLink(db: Db, link: DiscordTaskLink): void {
  const list = loadAll(db).filter((x) => x.taskId !== link.taskId && x.sourceMessageId !== link.sourceMessageId);
  list.push(link);
  saveAll(db, list);
}

export function findTaskBySourceMessageId(db: Db, messageId: string): DiscordTaskLink | null {
  return loadAll(db).find((x) => x.sourceMessageId === messageId) ?? null;
}

export function findTaskByReplyMessageId(db: Db, messageId: string): DiscordTaskLink | null {
  return loadAll(db).find((x) => x.replyMessageId === messageId) ?? null;
}

export function forgetTaskLinkByTaskId(db: Db, taskId: number): void {
  saveAll(db, loadAll(db).filter((x) => x.taskId !== taskId));
}
