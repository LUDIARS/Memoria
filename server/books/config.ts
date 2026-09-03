// books 設定の永続化 (app_settings の 1 キーに JSON で置く)。
// release-watch / shopping と同じ流儀。

import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import type { BooksConfig } from './types.js';

type Db = BetterSqlite3.Database;

const CURRENT_DEFAULTS_VERSION = 1;
const CONFIG_KEY = 'books.config';
const IMPORT_STATE_KEY = 'books.import_state';

export const booksConfigSchema = z.object({
  defaultsVersion: z.number().int().min(0).max(CURRENT_DEFAULTS_VERSION).default(0),
  enabled: z.boolean(),
  weeklyDay: z.number().int().min(0).max(6),
  weeklyHour: z.number().int().min(0).max(23),
  watchMinRating: z.number().int().min(1).max(5),
  maxWatchTargets: z.number().int().min(1).max(100),
  newReleaseLookbackDays: z.number().int().min(1).max(365),
  newReleaseLookaheadDays: z.number().int().min(0).max(365),
  suggestionCount: z.number().int().min(1).max(30),
  rakutenApplicationId: z.string().trim().max(120).default(''),
  sources: z.object({
    googleBooks: z.boolean(),
    openbd: z.boolean(),
    ndl: z.boolean(),
    rakuten: z.boolean(),
  }),
});

export const DEFAULT_BOOKS_CONFIG: BooksConfig = {
  defaultsVersion: CURRENT_DEFAULTS_VERSION,
  enabled: true,
  weeklyDay: 1,          // 月曜の朝に先週分をまとめて
  weeklyHour: 8,
  watchMinRating: 4,     // ★4 以上を 「良かった本」 とする
  maxWatchTargets: 30,
  newReleaseLookbackDays: 60,
  newReleaseLookaheadDays: 120,  // 予約段階で拾えると嬉しいので先も見る
  suggestionCount: 12,
  rakutenApplicationId: '',
  sources: { googleBooks: true, openbd: true, ndl: true, rakuten: true },
};

/** 楽天はアプリ ID が無ければ使えない。 設定の enabled だけでなく実効値を返す。 */
export function effectiveSources(config: BooksConfig): BooksConfig['sources'] {
  return {
    ...config.sources,
    rakuten: config.sources.rakuten && config.rakutenApplicationId.trim().length > 0,
  };
}

function readSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

function writeSetting(db: Db, key: string, value: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function getBooksConfig(db: Db): BooksConfig {
  const raw = readSetting(db, CONFIG_KEY);
  if (!raw) return { ...DEFAULT_BOOKS_CONFIG };
  try {
    const parsed = booksConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { ...DEFAULT_BOOKS_CONFIG };
    return parsed.data;
  } catch {
    return { ...DEFAULT_BOOKS_CONFIG };
  }
}

export function setBooksConfig(db: Db, config: BooksConfig): BooksConfig {
  const next = { ...config, defaultsVersion: CURRENT_DEFAULTS_VERSION };
  writeSetting(db, CONFIG_KEY, JSON.stringify(next));
  return next;
}

/**
 * 楽天アプリ ID を画面へ返すときのマスク。 保存時に空文字が来たら
 * 「変更なし」 と解釈するので、 マスク済みの値を往復させても消えない。
 */
export function maskRakutenId(config: BooksConfig): BooksConfig {
  const id = config.rakutenApplicationId;
  return { ...config, rakutenApplicationId: id ? `••••${id.slice(-4)}` : '' };
}

/** PUT 本文の楽天 ID が空 or マスク文字を含むなら既存値を維持する。 */
export function mergeRakutenId(current: BooksConfig, incoming: BooksConfig): BooksConfig {
  const value = incoming.rakutenApplicationId.trim();
  if (value === '' || value.includes('•')) {
    return { ...incoming, rakutenApplicationId: current.rakutenApplicationId };
  }
  return incoming;
}

/**
 * 読破記録インポートの状態。 Kindle の読破記録は API で取れないので
 * Amazon 「データのリクエスト」 を年 1 で落として取り込む運用。 その催促に使う。
 */
export interface BooksImportState {
  /** 最後に読破記録を取り込んだ日 (YYYY-MM-DD)。 未実施なら null。 */
  lastImportedOn: string | null;
  lastImportedCount: number;
  /** 催促を出した日。 同じ年に何度も催促しないため。 */
  lastReminderOn: string | null;
}

const DEFAULT_IMPORT_STATE: BooksImportState = {
  lastImportedOn: null,
  lastImportedCount: 0,
  lastReminderOn: null,
};

export function getBooksImportState(db: Db): BooksImportState {
  const raw = readSetting(db, IMPORT_STATE_KEY);
  if (!raw) return { ...DEFAULT_IMPORT_STATE };
  try {
    const parsed = JSON.parse(raw) as Partial<BooksImportState>;
    return {
      lastImportedOn: typeof parsed.lastImportedOn === 'string' ? parsed.lastImportedOn : null,
      lastImportedCount: typeof parsed.lastImportedCount === 'number' ? parsed.lastImportedCount : 0,
      lastReminderOn: typeof parsed.lastReminderOn === 'string' ? parsed.lastReminderOn : null,
    };
  } catch {
    return { ...DEFAULT_IMPORT_STATE };
  }
}

export function setBooksImportState(db: Db, state: BooksImportState): BooksImportState {
  writeSetting(db, IMPORT_STATE_KEY, JSON.stringify(state));
  return state;
}
