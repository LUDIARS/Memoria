// 新刊通知を #announce へ流す。 週次巡回そのものは books/scheduler.ts が回し、
// ここは 「未通知の行を拾って投げる」 だけ。 Discord が落ちていた週の分も
// notified_at が null のまま残るので、 復帰後にまとめて届く。

import type { Client } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { listPendingNotifications, markNotified, markImportReminded, shouldRemindImport } from '../../books/index.js';
import { formatNewReleases } from '../actions/book.js';
import { postAnnouncement } from '../notifier.js';

type Db = BetterSqlite3.Database;

const POLL_INTERVAL_MS = 10 * 60 * 1000;

/** 未通知の新刊を 1 回分投稿する。 投稿できた分だけ notified_at を立てる。 */
export async function postPendingBookNotices(client: Client, db: Db): Promise<number> {
  const pending = listPendingNotifications(db, 20);
  if (pending.length === 0) return 0;
  const posted = await postAnnouncement(client, db, formatNewReleases(pending, `新刊 ${pending.length} 件`));
  if (!posted) return 0;
  markNotified(db, pending.map((release) => release.id));
  return pending.length;
}

/**
 * 年 1 の読破記録インポート催促。 Kindle の読破記録は API で取れないので、
 * Amazon 「データのリクエスト」 → 取り込み、 を年 1 で促す。
 */
export async function postImportReminder(client: Client, db: Db): Promise<boolean> {
  if (!shouldRemindImport(db)) return false;
  const posted = await postAnnouncement(client, db, [
    '📚 読破記録の年次取り込みの時期です。',
    'Amazon の「データのリクエスト」から Kindle の履歴を書き出して、',
    'Memoria の 📚 本タブ →「読破記録を取り込む」に貼り付けてください。',
  ].join('\n'));
  if (!posted) return false;
  markImportReminded(db);
  return true;
}

export function startBookNotifyScheduler(client: Client, db: Db): void {
  const tick = async (): Promise<void> => {
    try {
      await postPendingBookNotices(client, db);
      await postImportReminder(client, db);
    } catch (error: unknown) {
      console.warn('[discord books] notify failed:', error instanceof Error ? error.message : String(error));
    }
  };
  setTimeout(() => { void tick(); }, 90_000).unref?.();
  setInterval(() => { void tick(); }, POLL_INTERVAL_MS).unref?.();
}
