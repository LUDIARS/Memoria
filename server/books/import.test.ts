// 読破記録の取り込みテスト。 Amazon データリクエスト CSV / My Clippings.txt /
// 日本語ヘッダ CSV が同じ入口で扱えること、 評価と感想を壊さないことを見る。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { detectFormat, parseReadingRecords } from './import-parse.js';
import { importReadingRecords, markImportReminded, shouldRemindImport } from './import.js';
import { ensureBooksSchema } from './schema.js';
import { insertBook, listBooks } from './store.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)');
  ensureBooksSchema(db);
  return db;
}

const AMAZON_CSV = [
  'Product Name,ASIN,Author,Read Date',
  '"沈黙の艦隊 1",B00ABCDEFG,"かわぐち かいじ",2025-04-01',
  '"引用符「,」入りの本",B00HIJKLMN,"著者 太郎",2025/05/02',
].join('\n');

const JP_CSV = [
  'タイトル,著者,読了日,ISBN',
  '和書テスト,山田 太郎,2024年3月4日,978-4-06-519465-6',
].join('\n');

const CLIPPINGS = [
  '沈黙の艦隊 1 (かわぐち かいじ)',
  '- 26ページ|位置No. 300-301のハイライト |作成日: 2025年4月1日 12:00:00',
  '',
  '本文の抜粋',
  '==========',
  '沈黙の艦隊 1 (かわぐち かいじ)',
  '- 30ページ|位置No. 400のハイライト |作成日: 2025年4月5日 12:00:00',
  '',
  '別の抜粋',
  '==========',
].join('\n');

test('CSV の引用符・カンマ込みフィールドを壊さずに読む', () => {
  const records = parseReadingRecords(AMAZON_CSV, 'csv');
  assert.equal(records.length, 2);
  assert.equal(records[0].title, '沈黙の艦隊 1');
  assert.equal(records[0].asin, 'B00ABCDEFG');
  assert.equal(records[0].readOn, '2025-04-01');
  assert.equal(records[1].title, '引用符「,」入りの本');
});

test('日本語ヘッダの CSV も同じ列に落ちる', () => {
  const records = parseReadingRecords(JP_CSV, 'csv');
  assert.equal(records[0].title, '和書テスト');
  assert.deepEqual(records[0].authors, ['山田 太郎']);
  assert.equal(records[0].readOn, '2024-03-04');
  assert.equal(records[0].isbn13, '9784065194656');
});

test('My Clippings は自動判定され、 同じ本は 1 件にまとまる', () => {
  assert.equal(detectFormat(CLIPPINGS), 'clippings');
  const records = parseReadingRecords(CLIPPINGS);
  assert.equal(records.length, 1);
  assert.equal(records[0].title, '沈黙の艦隊 1');
  assert.deepEqual(records[0].authors, ['かわぐち かいじ']);
  assert.equal(records[0].readOn, null);
});

test('購入日や登録日を読了日に読み替えない', () => {
  const records = parseReadingRecords([
    'Product Name,ASIN,Author,Order Date',
    '未読の本,B00UNREAD00,著者,2025-04-01',
  ].join('\n'), 'csv');
  assert.equal(records[0].readOn, null);
});

test('取り込みは既存の評価・感想を壊さず、 読了日だけ足す', () => {
  const db = openTestDb();
  insertBook(db, { title: '沈黙の艦隊 1', rating: 5, review: '名作' });
  const result = importReadingRecords(db, AMAZON_CSV, 'csv');

  assert.equal(result.parsed, 2);
  assert.equal(result.inserted, 1);
  assert.equal(result.updated, 1);

  const existing = listBooks(db).find((b) => b.title === '沈黙の艦隊 1');
  assert.equal(existing?.rating, 5);
  assert.equal(existing?.review, '名作');
  assert.equal(existing?.readOn, '2025-04-01');
});

test('取り込み直後は年次催促を出さない', () => {
  const db = openTestDb();
  assert.equal(shouldRemindImport(db), true);   // 一度も取り込んでいない
  importReadingRecords(db, AMAZON_CSV, 'csv');
  assert.equal(shouldRemindImport(db), false);
  assert.equal(shouldRemindImport(db, new Date(Date.now() + 400 * 86_400_000)), true);
});

test('年次催促は送信翌日に繰り返さない', () => {
  const db = openTestDb();
  markImportReminded(db, new Date('2026-01-02T09:00:00'));
  assert.equal(shouldRemindImport(db, new Date('2026-01-03T09:00:00')), false);
  assert.equal(shouldRemindImport(db, new Date('2027-01-03T09:00:00')), true);
});
