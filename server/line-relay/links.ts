// 「つなぐ」 用の 6 桁コードと、 トーク単位の紐付け。
// 紐付けたトークの発言は、 紐付けを作った Memoria の利用者 (シングルユーザー) の操作として扱う。

import { randomInt } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { ensureLineRelaySchema } from './schema.js';
import { contract } from '../shared/contract-runtime.js'; /* augur-inject:import:19bee9b7 */
import augurContract_c9e87b6a from '../../augur/contracts/line-relay-link.contract.js'; /* augur-inject:contract-predicate:dc9a56b9 */

type Db = BetterSqlite3.Database;

/** コードの有効期限。 */
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;

export type LinkCodeRedeem = 'linked' | 'unknown' | 'expired' | 'used';

export interface IssuedLinkCode {
  code: string;
  expires_at: string;
}

/** 新しいコードを出す。 まだ使われていない前のコードはこの時点で消す (有効なコードは常に 1 つ)。 */
export function issueLineLinkCode(db: Db, now: Date = new Date()): IssuedLinkCode {
  ensureLineRelaySchema(db);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS).toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM line_relay_link_codes WHERE used_at IS NULL OR code = ?').run(code);
    db.prepare('INSERT INTO line_relay_link_codes (code, expires_at, used_at, created_at) VALUES (?, ?, NULL, ?)')
      .run(code, expiresAt, now.toISOString());
  })();
  return { code, expires_at: expiresAt };
}

/** コードを使ってトークを紐付ける。 期限内・未使用のときだけ linked。 */
export function redeemLineLinkCode(db: Db, talk: string, code: string, now: Date = new Date()): LinkCodeRedeem {
  ensureLineRelaySchema(db);
  return db.transaction((): LinkCodeRedeem => {
    const row = db.prepare('SELECT expires_at, used_at FROM line_relay_link_codes WHERE code = ?')
      .get(code) as { expires_at: string; used_at: string | null } | undefined;
    if (!row) return 'unknown';
    if (row.used_at !== null) return 'used';
    if (Date.parse(row.expires_at) <= now.getTime()) return 'expired';
    const at = now.toISOString();
    db.prepare('UPDATE line_relay_link_codes SET used_at = ? WHERE code = ?').run(at, code);
    db.prepare(`INSERT INTO line_relay_links (talk, linked_at) VALUES (?, ?)
      ON CONFLICT(talk) DO UPDATE SET linked_at = excluded.linked_at`).run(talk, at);
    return 'linked';
  })();
}
// @ts-expect-error augur-inject
redeemLineLinkCode = contract(redeemLineLinkCode, { ...augurContract_c9e87b6a, contractId: 'C-16', mode: 'observe', sample: 1, where: 'server/line-relay/links.ts:34', rule: 'contract-wrap', id: 'c9e87b6a' }); /* augur-inject:contract-wrap:c9e87b6a */

export function isLineTalkLinked(db: Db, talk: string): boolean {
  ensureLineRelaySchema(db);
  return db.prepare('SELECT 1 FROM line_relay_links WHERE talk = ?').get(talk) !== undefined;
}

/** トークの紐付けと確認待ちを消す。 紐付けがあったら true。 */
export function forgetLineTalk(db: Db, talk: string): boolean {
  ensureLineRelaySchema(db);
  return db.transaction(() => {
    db.prepare('DELETE FROM line_relay_pending WHERE talk = ?').run(talk);
    return db.prepare('DELETE FROM line_relay_links WHERE talk = ?').run(talk).changes > 0;
  })();
}

export function countLineLinkedTalks(db: Db): number {
  ensureLineRelaySchema(db);
  return (db.prepare('SELECT COUNT(*) AS n FROM line_relay_links').get() as { n: number }).n;
}
