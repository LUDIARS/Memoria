// 興味の設定 (app_settings) と、 マップ上で開いた記録 (trend_clicks) の読み書き。

import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { DEFAULT_INTEREST_PREFS, type ClickStats, type TrendInterestPrefs } from './interest.js';
import { TREND_GENRES, type TrendGenre } from './types.js';

type Db = BetterSqlite3.Database;

const PREFS_KEY = 'trend_crawler.interest';
const MAX_KEYWORDS = 50;
/** よく開くジャンルの学習に使う期間。 これより古い記録は巡回のたびに消す。 */
export const CLICK_WINDOW_DAYS = 90;

export const interestPrefsSchema = z.object({
  genreWeights: z.partialRecord(z.enum(TREND_GENRES as [string, ...string[]]), z.number().min(0).max(3)).default({}),
  keywords: z.array(z.string().trim().min(1).max(40)).max(MAX_KEYWORDS).default([]),
});

export const clickInputSchema = z.object({
  key: z.string().min(1).max(200),
  genre: z.enum(TREND_GENRES as [string, ...string[]]),
  sourceId: z.string().min(1).max(80),
});

export function getInterestPrefs(db: Db): TrendInterestPrefs {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(PREFS_KEY) as { value: string | null } | undefined;
  if (!row?.value) return structuredClone(DEFAULT_INTEREST_PREFS);
  try {
    const parsed = interestPrefsSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data as TrendInterestPrefs : structuredClone(DEFAULT_INTEREST_PREFS);
  } catch {
    return structuredClone(DEFAULT_INTEREST_PREFS);
  }
}

export function setInterestPrefs(db: Db, prefs: TrendInterestPrefs): TrendInterestPrefs {
  // 同じ言葉の重複は 1 つにまとめる。
  const next: TrendInterestPrefs = { genreWeights: prefs.genreWeights, keywords: [...new Set(prefs.keywords)] };
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(PREFS_KEY, JSON.stringify(next));
  return next;
}

export function recordClick(db: Db, input: { key: string; genre: TrendGenre; sourceId: string }, at: Date = new Date()): void {
  db.prepare('INSERT INTO trend_clicks (item_key, genre, source_id, clicked_at) VALUES (?, ?, ?, ?)')
    .run(input.key, input.genre, input.sourceId, at.toISOString());
}

export function clickStats(db: Db, now: Date = new Date()): ClickStats {
  const since = new Date(now.getTime() - CLICK_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const byGenreRows = db.prepare(
    'SELECT genre, COUNT(*) AS n FROM trend_clicks WHERE clicked_at >= ? GROUP BY genre',
  ).all(since) as { genre: TrendGenre; n: number }[];
  const byKeyRows = db.prepare(
    'SELECT item_key, COUNT(*) AS n FROM trend_clicks WHERE clicked_at >= ? GROUP BY item_key',
  ).all(since) as { item_key: string; n: number }[];
  return {
    total: byGenreRows.reduce((sum, row) => sum + row.n, 0),
    byGenre: new Map(byGenreRows.map((row) => [row.genre, row.n])),
    byKey: new Map(byKeyRows.map((row) => [row.item_key, row.n])),
  };
}

export function pruneClicksBefore(db: Db, cutoffIso: string): number {
  return db.prepare('DELETE FROM trend_clicks WHERE clicked_at < ?').run(cutoffIso).changes;
}
