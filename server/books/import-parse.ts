// 読破記録ファイルのパース。 DB には触らない。
//
// Kindle の読破記録は公式 API が無いので、 Amazon 「データのリクエスト」 で
// 落とした CSV を年 1 で取り込む運用にしている。 ブクログ / 読書メーターの
// エクスポート CSV と Kindle 端末の My Clippings.txt も同じ入口で受ける。

import { cleanAuthors, normalizeDate, normalizeIsbn13 } from './bib.js';

export interface ParsedReadingRecord {
  title: string;
  authors: string[];
  isbn13: string | null;
  asin: string | null;
  readOn: string | null;
}

// ── CSV ────────────────────────────────────────────────────────────

/** RFC4180 相当の最小 CSV パーサ (引用符内の改行・カンマ・二重引用符に対応)。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (quoted) {
      if (char === '"') {
        if (body[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/**
 * 列名の別名表。 Amazon のデータリクエストは書き出しごとに列名が変わるうえ、
 * 日本語ロケールと英語ロケールで別物になるので、 部分一致で拾う。
 */
const COLUMN_ALIASES: Record<keyof ParsedReadingRecord | 'ignore', string[]> = {
  title: ['title', 'product name', 'productname', 'タイトル', '書籍名', '商品名', '本のタイトル'],
  authors: ['author', 'authors', 'creator', '著者', '作者'],
  isbn13: ['isbn', 'isbn13', 'isbn-13'],
  asin: ['asin', 'product id', 'productid', '商品コード'],
  readOn: [
    'read date', 'date read', 'end date', 'completion date', 'finished date',
    '読了日', '読了', '読み終わった日',
  ],
  ignore: [],
};

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[_\-\s]+/g, ' ');
}

/** ヘッダ行から列位置を決める。 見つからない項目は -1。 */
export function detectColumns(header: string[]): Record<keyof ParsedReadingRecord, number> {
  const normalized = header.map(normalizeHeader);
  const find = (aliases: string[]): number => {
    for (const alias of aliases) {
      const exact = normalized.indexOf(alias);
      if (exact >= 0) return exact;
    }
    for (const alias of aliases) {
      const partial = normalized.findIndex((name) => name.includes(alias));
      if (partial >= 0) return partial;
    }
    return -1;
  };
  return {
    title: find(COLUMN_ALIASES.title),
    authors: find(COLUMN_ALIASES.authors),
    isbn13: find(COLUMN_ALIASES.isbn13),
    asin: find(COLUMN_ALIASES.asin),
    readOn: find(COLUMN_ALIASES.readOn),
  };
}

export function parseReadingCsv(text: string): ParsedReadingRecord[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const columns = detectColumns(rows[0]);
  if (columns.title < 0) return [];
  const out: ParsedReadingRecord[] = [];
  for (const row of rows.slice(1)) {
    const cell = (index: number): string => (index >= 0 ? (row[index] ?? '').trim() : '');
    const title = cell(columns.title);
    if (!title) continue;
    out.push({
      title,
      authors: cleanAuthors(cell(columns.authors).split(/[,、;；]/)),
      isbn13: normalizeIsbn13(cell(columns.isbn13)),
      asin: cell(columns.asin) || null,
      readOn: normalizeDate(cell(columns.readOn)),
    });
  }
  return out;
}

// ── My Clippings.txt ───────────────────────────────────────────────

const CLIPPING_SEPARATOR = /^=+$/m;

/**
 * Kindle 端末の My Clippings.txt。 1 ブロックの 1 行目が 「タイトル (著者)」、
 * 2 行目はハイライト日時であり読了日ではない。 同じ本の複数ブロックは 1 件にまとめる。
 */
export function parseMyClippings(text: string): ParsedReadingRecord[] {
  const byTitle = new Map<string, ParsedReadingRecord>();
  for (const block of text.split(CLIPPING_SEPARATOR)) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const heading = lines[0];
    const match = heading.match(/^(.*?)\s*[（(]([^（()）]*)[）)]\s*$/);
    const title = (match ? match[1] : heading).trim();
    if (!title) continue;
    const authors = match ? cleanAuthors(match[2].split(/[,、;；]/)) : [];
    const readOn = null;
    const existing = byTitle.get(title);
    if (!existing) {
      byTitle.set(title, { title, authors, isbn13: null, asin: null, readOn });
      continue;
    }
    if (existing.authors.length === 0 && authors.length > 0) existing.authors = authors;
  }
  return [...byTitle.values()];
}

export type ReadingImportFormat = 'csv' | 'clippings';

export function detectFormat(text: string): ReadingImportFormat {
  return CLIPPING_SEPARATOR.test(text) ? 'clippings' : 'csv';
}

export function parseReadingRecords(text: string, format: ReadingImportFormat | 'auto' = 'auto'): ParsedReadingRecord[] {
  const kind = format === 'auto' ? detectFormat(text) : format;
  return kind === 'clippings' ? parseMyClippings(text) : parseReadingCsv(text);
}
