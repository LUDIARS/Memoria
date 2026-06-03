// Discord Bot の起動/停止エントリ。 server/index.ts の listen 後に呼ぶ。
// enabled かつ token/self/guild が揃っているときだけ起動する。全て best-effort。

import type { Client } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { discordReady } from './settings.js';
import { createDiscordClient } from './client.js';
import { postAnnouncement } from './notifier.js';
import { findTrigger } from './notify/config.js';
import { fireTrigger } from './notify/engine.js';
import { postRssNews, type NewsPostResult } from './news.js';

type Db = BetterSqlite3.Database;

let current: Client | null = null;

/** Discord Bot を起動する (条件を満たさなければ skip)。 */
export async function startDiscordBot(db: Db): Promise<void> {
  if (current) return; // 二重起動防止
  const ready = discordReady(db);
  if (!ready.ok) {
    console.log(`[discord] 起動 skip: ${ready.reason}`);
    return;
  }
  current = await createDiscordClient(db);
}

/** Discord Bot を停止する。 */
export function stopDiscordBot(): void {
  if (!current) return;
  try { current.destroy(); } catch { /* swallow */ }
  current = null;
}

/**
 * 既存の通知 (日記完了 / リマインダー等) を Discord #announce に投稿する seam。
 * Bot 未起動 / 未接続なら何もしない (best-effort)。 Memoria の通知トリガからこれを
 * 呼べば「アナウンスを Discord にも流す」 が実現する。
 */
export async function announceToDiscord(db: Db, text: string): Promise<void> {
  if (!current?.isReady()) return;
  await postAnnouncement(current, db, text);
}

/**
 * RSS「今日のダイジェスト + 気になるニュース」 を #news に即時投稿する seam。
 * 設定 UI / API の「Discord に投稿」 から呼ぶ。 Bot 未起動なら not_ready。
 */
export async function postRssNewsNow(db: Db): Promise<NewsPostResult> {
  if (!current?.isReady()) return { ok: false, reason: 'not_ready', digestPosted: false, trendingPosted: false };
  return postRssNews(current, db);
}

/**
 * 指定 id の通知トリガーを即時発火する (設定 UI の「テスト送信」 用)。
 * Bot 未起動なら not_ready。 該当 0 件でもテストとして送る (postWhenEmpty)。
 */
export async function fireNotifyTriggerById(
  db: Db,
  id: string,
): Promise<{ ok: boolean; reason?: string; count?: number }> {
  if (!current?.isReady()) return { ok: false, reason: 'not_ready' };
  const trigger = findTrigger(db, id);
  if (!trigger) return { ok: false, reason: 'not_found' };
  const r = await fireTrigger(current, db, trigger, { postWhenEmpty: true });
  return { ok: true, count: r.count };
}
