// 「タスク」「にっき」 の確認ボタン待ち。 ボタン (postback) が押されたら 1 回だけ取り出す。

import { randomBytes } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { ensureLineRelaySchema } from './schema.js';

type Db = BetterSqlite3.Database;

/** 確認ボタンの有効期限。 */
export const PENDING_TTL_MS = 30 * 60 * 1000;

export type PendingAction = 'task' | 'diary';

export interface LinePending {
  id: string;
  action: PendingAction;
  text: string;
}

export function createLinePending(db: Db, talk: string, action: PendingAction, text: string, now: Date = new Date()): string {
  ensureLineRelaySchema(db);
  const id = randomBytes(12).toString('base64url');
  db.transaction(() => {
    db.prepare('DELETE FROM line_relay_pending WHERE expires_at <= ?').run(now.toISOString());
    db.prepare('INSERT INTO line_relay_pending (id, talk, action, text, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, talk, action, text, new Date(now.getTime() + PENDING_TTL_MS).toISOString());
  })();
  return id;
}

/** 同じトークの期限内の確認待ちを取り出して消す。 無ければ null。 */
export function takeLinePending(db: Db, talk: string, id: string, now: Date = new Date()): LinePending | null {
  ensureLineRelaySchema(db);
  return db.transaction((): LinePending | null => {
    const row = db.prepare('SELECT id, action, text, expires_at FROM line_relay_pending WHERE id = ? AND talk = ?')
      .get(id, talk) as (LinePending & { expires_at: string }) | undefined;
    if (!row) return null;
    db.prepare('DELETE FROM line_relay_pending WHERE id = ?').run(id);
    if (Date.parse(row.expires_at) <= now.getTime()) return null;
    return { id: row.id, action: row.action, text: row.text };
  })();
}
