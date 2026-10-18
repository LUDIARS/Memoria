// その日の日記メモ (diary_entries.notes) の末尾へ「HH:MM 本文」 を 1 行足す。 既存の本文は上書きしない。
// タスク発行の記録と、 LINE からの「にっき」 で共用する。

import type BetterSqlite3 from 'better-sqlite3';
import { getDiary, upsertDiary } from '../db.js';
import { contract } from '../shared/contract-runtime.js'; /* augur-inject:import:d2fbe5c5 */
import augurContract_69dc240f from '../../augur/contracts/diary-append.contract.js'; /* augur-inject:contract-predicate:bcde5535 */

type Db = BetterSqlite3.Database;

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function appendDiaryLine(db: Db, line: string, now: Date = new Date()): void {
  const date = formatLocalDate(now);
  const row = getDiary(db, date);
  const previous = String(row?.notes ?? '').trimEnd();
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const next = previous ? `${previous}\n${hour}:${minute} ${line}` : `${hour}:${minute} ${line}`;
  upsertDiary(db, { date, notes: next, status: row?.status ?? 'pending' });
}
// @ts-expect-error augur-inject
appendDiaryLine = contract(appendDiaryLine, { ...augurContract_69dc240f, contractId: 'C-17', mode: 'observe', sample: 1, where: 'server/shared/diary-append.ts:16', rule: 'contract-wrap', id: '69dc240f' }); /* augur-inject:contract-wrap:69dc240f */
