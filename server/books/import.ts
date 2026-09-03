// 読破記録の取り込み。 パース結果を books へ upsert し、 年 1 の催促状態を更新する。
//
// 取り込みは 「読んだ」 という事実だけを入れる。 評価 (お気に入り) は
// neco が手で付けるものなので、 既存の rating / review は絶対に触らない。

import type BetterSqlite3 from 'better-sqlite3';
import { getBooksImportState, setBooksImportState } from './config.js';
import { parseReadingRecords, type ReadingImportFormat } from './import-parse.js';
import { findBook, insertBook, updateBook } from './store.js';

type Db = BetterSqlite3.Database;

export interface ReadingImportResult {
  parsed: number;
  inserted: number;
  /** 既存行に読了日だけ足した件数。 */
  updated: number;
  /** 既に同じ読了日が入っていて何もしなかった件数。 */
  skipped: number;
}

function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function importReadingRecords(
  db: Db,
  text: string,
  format: ReadingImportFormat | 'auto' = 'auto',
  now: Date = new Date(),
): ReadingImportResult {
  const records = parseReadingRecords(text, format);
  const result: ReadingImportResult = { parsed: records.length, inserted: 0, updated: 0, skipped: 0 };

  db.transaction(() => {
    for (const record of records) {
      const existing = findBook(db, record.isbn13, record.title);
      if (!existing) {
        insertBook(db, {
          isbn13: record.isbn13,
          asin: record.asin,
          title: record.title,
          authors: record.authors,
          readOn: record.readOn,
          source: 'import',
        }, now);
        result.inserted += 1;
        continue;
      }
      // 読了日が未記入か、 取り込んだ日付のほうが古い (=初読) なら更新する。
      const shouldUpdate = record.readOn !== null
        && (existing.readOn === null || record.readOn < existing.readOn);
      const needsAsin = record.asin !== null && existing.asin === null;
      if (!shouldUpdate && !needsAsin) { result.skipped += 1; continue; }
      updateBook(db, existing.id, {
        ...(shouldUpdate ? { readOn: record.readOn } : {}),
        ...(needsAsin ? { asin: record.asin } : {}),
      }, now);
      result.updated += 1;
    }
  })();

  const state = getBooksImportState(db);
  setBooksImportState(db, {
    ...state,
    lastImportedOn: localDateString(now),
    lastImportedCount: result.inserted + result.updated,
  });
  return result;
}

const REMINDER_INTERVAL_DAYS = 365;

/**
 * 年 1 のインポート催促を出すべきか。 Amazon のデータリクエストは手作業なので、
 * 前回取り込みから 1 年経ったら 1 回だけ Discord に声をかける。
 */
export function shouldRemindImport(db: Db, now: Date = new Date()): boolean {
  const state = getBooksImportState(db);
  const today = localDateString(now);
  if (state.lastReminderOn === today) return false;
  const since = state.lastImportedOn && state.lastReminderOn
    ? (state.lastImportedOn > state.lastReminderOn ? state.lastImportedOn : state.lastReminderOn)
    : state.lastImportedOn ?? state.lastReminderOn;
  if (!since) return true;   // 一度も取り込んでいない
  const elapsedDays = (now.getTime() - new Date(`${since}T00:00:00`).getTime()) / 86_400_000;
  return elapsedDays >= REMINDER_INTERVAL_DAYS;
}

export function markImportReminded(db: Db, now: Date = new Date()): void {
  const state = getBooksImportState(db);
  setBooksImportState(db, { ...state, lastReminderOn: localDateString(now) });
}
