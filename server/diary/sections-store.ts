// diary_sections — 外部サービスが日記に書き込む節 (例: Concordia のデイリーゴールのまとめ)。
// diary_entries とは別テーブルに置き、 再生成 (generate) やユーザメモ (notes) と干渉させない。
// Spec: spec/feature/diary.md (外部節), spec/data/diary.md

import type BetterSqlite3 from 'better-sqlite3';
import { contract } from '../shared/contract-runtime.js'; /* augur-inject:import:3cf9a5c0 */
import augurContract_eddf1dfe from '../../augur/contracts/diary-section-input.contract.js'; /* augur-inject:contract-predicate:87bfb4ec */
import augurContract_f118dcc2 from '../../augur/contracts/diary-section-put.contract.js'; /* augur-inject:contract-predicate:44f0067b */
import augurContract_869f463b from '../../augur/contracts/diary-section-delete.contract.js'; /* augur-inject:contract-predicate:dbd494d0 */

type Db = BetterSqlite3.Database;

export const MAX_SECTION_TITLE_CHARS = 200;
export const MAX_SECTION_MARKDOWN_BYTES = 200 * 1024;
export const DIARY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const SECTION_SOURCE_RE = /^[a-z0-9-]{1,64}$/;

export interface DiarySection {
  date: string;
  source: string;
  title: string;
  markdown: string;
  created_at: string;
  updated_at: string;
}

export type DiarySectionInput =
  | { ok: true; title: string; markdown: string }
  | { ok: false; error: string };

/** Idempotent; called by every router that touches diary_sections. */
export function ensureDiarySectionsSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS diary_sections (
    date       TEXT NOT NULL,
    source     TEXT NOT NULL,
    title      TEXT NOT NULL,
    markdown   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (date, source)
  )`);
}

export function validateDiarySectionInput(date: string, source: string, body: unknown): DiarySectionInput {
  if (!DIARY_DATE_RE.test(date)) return { ok: false, error: 'invalid date' };
  if (!SECTION_SOURCE_RE.test(source)) return { ok: false, error: 'invalid source' };
  const { title, markdown } = (body ?? {}) as { title?: unknown; markdown?: unknown };
  if (typeof title !== 'string' || !title.trim()) return { ok: false, error: 'title is required' };
  if (title.length > MAX_SECTION_TITLE_CHARS) return { ok: false, error: `title exceeds ${MAX_SECTION_TITLE_CHARS} chars` };
  if (typeof markdown !== 'string' || !markdown.trim()) return { ok: false, error: 'markdown is required' };
  if (Buffer.byteLength(markdown, 'utf8') > MAX_SECTION_MARKDOWN_BYTES) return { ok: false, error: 'markdown exceeds 200KB' };
  return { ok: true, title, markdown };
}
// @ts-expect-error augur-inject
validateDiarySectionInput = contract(validateDiarySectionInput, { ...augurContract_eddf1dfe, contractId: 'C-11', mode: 'observe', sample: 1, where: 'server/diary/sections-store.ts:40', rule: 'contract-wrap', id: 'eddf1dfe' }); /* augur-inject:contract-wrap:eddf1dfe */

export function getDiarySection(db: Db, date: string, source: string): DiarySection | null {
  return (db.prepare(
    'SELECT date, source, title, markdown, created_at, updated_at FROM diary_sections WHERE date = ? AND source = ?',
  ).get(date, source) as DiarySection | undefined) ?? null;
}

export function listDiarySections(db: Db, date: string): DiarySection[] {
  return db.prepare(
    'SELECT date, source, title, markdown, created_at, updated_at FROM diary_sections WHERE date = ? ORDER BY created_at, source',
  ).all(date) as DiarySection[];
}

/** Replace the (date, source) section. diary_entries is never touched. */
export function putDiarySection(db: Db, date: string, source: string, input: { title: string; markdown: string }): DiarySection {
  db.prepare(`
    INSERT INTO diary_sections (date, source, title, markdown) VALUES (?, ?, ?, ?)
    ON CONFLICT(date, source) DO UPDATE SET
      title = excluded.title, markdown = excluded.markdown, updated_at = datetime('now')
  `).run(date, source, input.title, input.markdown);
  return getDiarySection(db, date, source) as DiarySection;
}
// @ts-expect-error augur-inject
putDiarySection = contract(putDiarySection, { ...augurContract_f118dcc2, contractId: 'C-12', mode: 'observe', sample: 1, where: 'server/diary/sections-store.ts:64', rule: 'contract-wrap', id: 'f118dcc2' }); /* augur-inject:contract-wrap:f118dcc2 */

export function deleteDiarySection(db: Db, date: string, source: string): boolean {
  return db.prepare('DELETE FROM diary_sections WHERE date = ? AND source = ?').run(date, source).changes > 0;
}

/** Remove every external section of a day (used by DELETE /api/diary/:date). */
export function deleteDiarySections(db: Db, date: string): number {
  return db.prepare('DELETE FROM diary_sections WHERE date = ?').run(date).changes;
}
// @ts-expect-error augur-inject
deleteDiarySections = contract(deleteDiarySections, { ...augurContract_869f463b, contractId: 'C-13', mode: 'observe', sample: 1, where: 'server/diary/sections-store.ts:78', rule: 'contract-wrap', id: '869f463b' }); /* augur-inject:contract-wrap:869f463b */
