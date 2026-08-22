import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import type { ReleaseDigest, ReleaseSource, ReleaseWatchConfig } from './types.js';

type Db = BetterSqlite3.Database;

const CURRENT_DEFAULTS_VERSION = 1;
const MAX_SOURCES = 40;
export const MAX_VERSIONS_PER_SOURCE = 10;

const httpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'http(s) URL required');

const safeRegexSchema = z.string().max(200).refine((value) => {
  try { new RegExp(value); return true; } catch { return false; }
}, 'invalid regular expression');

export const releaseSourceSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['github_releases', 'github_tags', 'rss', 'html']),
  url: httpUrlSchema,
  notesUrlTemplate: z.union([httpUrlSchema, z.null()]).default(null),
  includePattern: z.union([safeRegexSchema, z.null()]).default(null),
  enabled: z.boolean(),
}).superRefine((source, ctx) => {
  if ((source.kind === 'github_releases' || source.kind === 'github_tags') && !parseGithubRepo(source.url)) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'https://github.com/<owner>/<repo> required' });
  }
});

export const releaseWatchConfigSchema = z.object({
  defaultsVersion: z.number().int().min(0).max(CURRENT_DEFAULTS_VERSION).default(0),
  enabled: z.boolean(),
  refreshHour: z.number().int().min(0).max(23),
  versionsPerSource: z.number().int().min(1).max(MAX_VERSIONS_PER_SOURCE),
  sources: z.array(releaseSourceSchema).max(MAX_SOURCES),
}).superRefine((config, ctx) => {
  const ids = new Set<string>();
  config.sources.forEach((source, index) => {
    if (ids.has(source.id)) ctx.addIssue({ code: 'custom', path: ['sources', index, 'id'], message: 'duplicate source id' });
    ids.add(source.id);
  });
});

const releaseEntrySchema = z.object({
  version: z.string().min(1).max(120),
  url: httpUrlSchema,
  publishedAt: z.string().nullable(),
  summaryJa: z.string().max(4_000),
  summarizedAt: z.string(),
});

export const releaseDigestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  generatedAt: z.string(),
  sources: z.array(z.object({
    sourceId: z.string().min(1).max(80),
    sourceName: z.string().min(1).max(80),
    sourceKind: z.enum(['github_releases', 'github_tags', 'rss', 'html']),
    url: httpUrlSchema,
    entries: z.array(releaseEntrySchema).max(MAX_VERSIONS_PER_SOURCE),
    fetchedAt: z.string(),
    error: z.string().max(400).nullable(),
  })).max(MAX_SOURCES),
});

/** `https://github.com/<owner>/<repo>` から owner/repo を取り出す (それ以外は null)。 */
export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.hostname !== 'github.com') return null;
  const match = parsed.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

export const DEFAULT_RELEASE_WATCH_CONFIG: ReleaseWatchConfig = {
  defaultsVersion: CURRENT_DEFAULTS_VERSION,
  enabled: true,
  refreshHour: 6,
  versionsPerSource: 5,
  sources: [
    {
      id: 'claude-code',
      name: 'Claude Code',
      kind: 'github_releases',
      url: 'https://github.com/anthropics/claude-code',
      notesUrlTemplate: null,
      includePattern: null,
      enabled: true,
    },
    {
      id: 'codex-cli',
      name: 'Codex CLI',
      kind: 'github_releases',
      url: 'https://github.com/openai/codex',
      notesUrlTemplate: null,
      includePattern: '^rust-v\\d+\\.\\d+\\.\\d+$',
      enabled: true,
    },
    {
      id: 'unity',
      name: 'Unity (LTS)',
      kind: 'rss',
      url: 'https://unity.com/releases/editor/lts-releases.xml',
      notesUrlTemplate: null,
      includePattern: null,
      enabled: true,
    },
    {
      id: 'unreal-engine',
      name: 'Unreal Engine',
      kind: 'html',
      url: 'https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5-release-notes',
      notesUrlTemplate: null,
      includePattern: null,
      enabled: true,
    },
    {
      id: 'git',
      name: 'Git',
      kind: 'github_tags',
      url: 'https://github.com/git/git',
      notesUrlTemplate: 'https://raw.githubusercontent.com/git/git/{tag}/Documentation/RelNotes/{version}.adoc',
      includePattern: '^v\\d+\\.\\d+\\.\\d+$',
      enabled: true,
    },
  ],
};

const CONFIG_KEY = 'release_watch.config';
const DIGEST_KEY = 'release_watch.latest_digest';

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

export function getReleaseWatchConfig(db: Db): ReleaseWatchConfig {
  const raw = readSetting(db, CONFIG_KEY);
  if (raw === null) return structuredClone(DEFAULT_RELEASE_WATCH_CONFIG);
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { throw new Error('release_watch.config is not valid JSON'); }
  const parsed = releaseWatchConfigSchema.safeParse(decoded);
  if (!parsed.success) throw new Error(`release_watch.config is invalid: ${parsed.error.message}`);
  return parsed.data;
}

export function setReleaseWatchConfig(db: Db, config: ReleaseWatchConfig): ReleaseWatchConfig {
  const next: ReleaseWatchConfig = { ...config, defaultsVersion: CURRENT_DEFAULTS_VERSION };
  writeSetting(db, CONFIG_KEY, JSON.stringify(next));
  return next;
}

export function getReleaseDigest(db: Db): ReleaseDigest | null {
  const raw = readSetting(db, DIGEST_KEY);
  if (raw === null) return null;
  try {
    const parsed = releaseDigestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function setReleaseDigest(db: Db, digest: ReleaseDigest): void {
  writeSetting(db, DIGEST_KEY, JSON.stringify(digest));
}

export function findSource(config: ReleaseWatchConfig, id: string): ReleaseSource | null {
  return config.sources.find((source) => source.id === id) ?? null;
}
