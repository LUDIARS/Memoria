// 複数 URL を一括でブクマ化する。
// /api/dig/:id/save (Dig 結果 → ブクマ) と /api/visits/bookmark (履歴 → ブクマ)
// の両方が呼ぶ。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import {
  insertBookmark, recordAccess,
  findBookmarkByUrl, deleteVisit,
} from '../db.js';
import { fetchPageHtml } from './fetch-page.js';

type Db = BetterSqlite3.Database;

export interface BulkSaveResult {
  url: string;
  status: 'queued' | 'duplicate' | 'skipped' | 'error';
  id?: number;
  error?: string;
}

export interface BulkSaveDeps {
  db: Db;
  htmlDir: string;
  enqueueSummary: (id: number) => void;
}

export async function bulkSaveUrls(deps: BulkSaveDeps, urls: unknown[]): Promise<BulkSaveResult[]> {
  const { db, htmlDir, enqueueSummary } = deps;
  const results: BulkSaveResult[] = [];
  for (const url of urls) {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      results.push({ url: String(url), status: 'skipped', error: 'invalid url' });
      continue;
    }
    const existing = findBookmarkByUrl(db, url);
    if (existing) {
      deleteVisit(db, url);
      results.push({ url, status: 'duplicate', id: existing.id });
      continue;
    }
    try {
      const visit = db.prepare(`SELECT title FROM page_visits WHERE url = ?`).get(url) as { title?: string } | undefined;
      const fetched = await fetchPageHtml(url);
      const title = (visit?.title || fetched.title || url).slice(0, 500);

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const safe = ts + '_' + Math.random().toString(36).slice(2, 8) + '.html';
      writeFileSync(join(htmlDir, safe), fetched.html, 'utf8');

      const id = insertBookmark(db, { url, title, htmlPath: safe });
      recordAccess(db, id);
      enqueueSummary(id);
      deleteVisit(db, url);
      results.push({ url, status: 'queued', id });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ url, status: 'error', error: msg });
    }
  }
  return results;
}
