// app_settings の trend_crawler.* を読み書きする。 設定と最新の AI 要約をここに置く
// (取得結果の履歴は件数が多いので schema.ts のテーブルに置く)。

import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { DEFAULT_TREND_SOURCE_RELEASES, DEFAULT_TREND_SOURCES } from './default-sources.js';
import { TREND_GENRES, TREND_SOURCE_KINDS, type TrendCrawlerConfig, type TrendSource, type TrendSummary } from './types.js';

type Db = BetterSqlite3.Database;

const CURRENT_DEFAULTS_VERSION = Math.max(...DEFAULT_TREND_SOURCE_RELEASES.map((release) => release.version));
const MAX_SOURCES = 60;
export const MAX_ITEMS_PER_SOURCE = 50;

const httpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'http(s) URL required');

export const trendSourceSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().trim().min(1).max(80),
  genre: z.enum(TREND_GENRES as [string, ...string[]]),
  kind: z.enum(TREND_SOURCE_KINDS as [string, ...string[]]),
  url: httpUrlSchema,
  enabled: z.boolean(),
}).superRefine((source, ctx) => {
  const host = new URL(source.url).hostname;
  if (source.kind === 'apple_top' && host !== 'rss.marketingtools.apple.com' && host !== 'rss.applemarketingtools.com') {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'Apple のランキング URL (rss.marketingtools.apple.com) が必要です' });
  }
  if (source.kind === 'wikipedia_top' && !/^[a-z-]+\.wikipedia\.org$/.test(host)) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'https://<言語>.wikipedia.org 形式の URL が必要です' });
  }
}) as unknown as z.ZodType<TrendSource>;

export const trendCrawlerConfigSchema = z.object({
  defaultsVersion: z.number().int().min(0).max(CURRENT_DEFAULTS_VERSION).default(0),
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(24),
  itemsPerSource: z.number().int().min(1).max(MAX_ITEMS_PER_SOURCE),
  retentionDays: z.number().int().min(1).max(365),
  summarize: z.boolean(),
  sources: z.array(trendSourceSchema).max(MAX_SOURCES),
}).superRefine((config, ctx) => {
  const ids = new Set<string>();
  config.sources.forEach((source, index) => {
    if (ids.has(source.id)) ctx.addIssue({ code: 'custom', path: ['sources', index, 'id'], message: 'duplicate source id' });
    ids.add(source.id);
  });
});

const trendSummarySchema = z.object({
  generatedAt: z.string(),
  overall: z.string().max(2_000).nullable(),
  genres: z.record(z.string(), z.string().max(2_000)),
});

export const DEFAULT_TREND_CRAWLER_CONFIG: TrendCrawlerConfig = {
  defaultsVersion: CURRENT_DEFAULTS_VERSION,
  enabled: true,
  intervalHours: 3,
  itemsPerSource: 20,
  retentionDays: 30,
  summarize: true,
  sources: DEFAULT_TREND_SOURCES,
};

const CONFIG_KEY = 'trend_crawler.config';
const SUMMARY_KEY = 'trend_crawler.latest_summary';

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

/**
 * 保存済み設定の作成後に既定へ加わったソースを足す。 利用者が消した古い既定ソースは戻さない
 * (その版より新しい既定だけを対象にする)。 同じ id が既にあれば足さない。
 */
export function withNewDefaultSources(config: TrendCrawlerConfig): TrendCrawlerConfig {
  if (config.defaultsVersion >= CURRENT_DEFAULTS_VERSION) return config;
  const ids = new Set(config.sources.map((source) => source.id));
  const added = DEFAULT_TREND_SOURCE_RELEASES
    .filter((release) => release.version > config.defaultsVersion)
    .flatMap((release) => release.sources)
    .filter((source) => !ids.has(source.id))
    .slice(0, Math.max(0, MAX_SOURCES - config.sources.length));
  return { ...config, defaultsVersion: CURRENT_DEFAULTS_VERSION, sources: [...config.sources, ...structuredClone(added)] };
}

export function getTrendCrawlerConfig(db: Db): TrendCrawlerConfig {
  const raw = readSetting(db, CONFIG_KEY);
  if (raw === null) return structuredClone(DEFAULT_TREND_CRAWLER_CONFIG);
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { throw new Error('trend_crawler.config is not valid JSON'); }
  const parsed = trendCrawlerConfigSchema.safeParse(decoded);
  if (!parsed.success) throw new Error(`trend_crawler.config is invalid: ${parsed.error.message}`);
  return withNewDefaultSources(parsed.data as TrendCrawlerConfig);
}

export function setTrendCrawlerConfig(db: Db, config: TrendCrawlerConfig): TrendCrawlerConfig {
  const next: TrendCrawlerConfig = { ...config, defaultsVersion: CURRENT_DEFAULTS_VERSION };
  writeSetting(db, CONFIG_KEY, JSON.stringify(next));
  return next;
}

export function getTrendSummary(db: Db): TrendSummary | null {
  const raw = readSetting(db, SUMMARY_KEY);
  if (raw === null) return null;
  try {
    const parsed = trendSummarySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data as TrendSummary : null;
  } catch {
    return null;
  }
}

export function setTrendSummary(db: Db, summary: TrendSummary): void {
  writeSetting(db, SUMMARY_KEY, JSON.stringify(summary));
}

export function findTrendSource(config: TrendCrawlerConfig, id: string): TrendSource | null {
  return config.sources.find((source) => source.id === id) ?? null;
}
