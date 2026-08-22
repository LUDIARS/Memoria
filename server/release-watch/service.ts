import type BetterSqlite3 from 'better-sqlite3';
import { getReleaseDigest, getReleaseWatchConfig, setReleaseDigest } from './config.js';
import { fetchGithubReleases, fetchGithubTags } from './github-source.js';
import { fetchHtmlReleases } from './html-source.js';
import { fetchRssReleases } from './rss-source.js';
import { summarizeRelease, type SummaryRunner } from './summarizer.js';
import type {
  RawRelease,
  ReleaseDigest,
  ReleaseEntry,
  ReleaseSource,
  ReleaseSourceDigest,
  ReleaseWatchConfig,
} from './types.js';

type Db = BetterSqlite3.Database;

export type ReleaseFetcher = (source: ReleaseSource, limit: number) => Promise<RawRelease[]>;

export interface ReleaseServiceDeps {
  fetchReleases?: ReleaseFetcher;
  summarize?: SummaryRunner;
}

export const fetchReleasesByKind: ReleaseFetcher = (source, limit) => {
  switch (source.kind) {
    case 'github_releases': return fetchGithubReleases(source, limit);
    case 'github_tags': return fetchGithubTags(source, limit);
    case 'rss': return fetchRssReleases(source, limit);
    case 'html': return fetchHtmlReleases(source, limit);
  }
};

function localDate(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 400);
}

/**
 * 1 ソース分を更新する。 要約は前回 digest に同一 version があれば再利用し、 新規 version だけ LLM に掛ける。
 * 取得失敗時は前回の entries を残して error だけ載せる (画面から消さない)。
 */
export async function refreshSource(
  source: ReleaseSource,
  limit: number,
  previous: ReleaseSourceDigest | null,
  now: Date,
  deps: ReleaseServiceDeps = {},
): Promise<ReleaseSourceDigest> {
  const fetchReleases = deps.fetchReleases ?? fetchReleasesByKind;
  const cached = new Map<string, ReleaseEntry>((previous?.entries ?? []).map((e) => [e.version, e]));
  const base = { sourceId: source.id, sourceName: source.name, sourceKind: source.kind, url: source.url, fetchedAt: now.toISOString() };
  let raw: RawRelease[];
  try {
    raw = await fetchReleases(source, limit);
  } catch (error: unknown) {
    return { ...base, entries: previous?.entries ?? [], error: errorMessage(error) };
  }
  const entries: ReleaseEntry[] = [];
  const failures: string[] = [];
  for (const release of raw.slice(0, limit)) {
    const hit = cached.get(release.version);
    if (hit) { entries.push({ ...hit, url: release.url, publishedAt: release.publishedAt ?? hit.publishedAt }); continue; }
    try {
      entries.push(await summarizeRelease(source, release, now, deps.summarize));
    } catch (error: unknown) {
      failures.push(`${release.version}: ${errorMessage(error)}`);
      entries.push({ version: release.version, url: release.url, publishedAt: release.publishedAt, summaryJa: '（要約に失敗。 次回の巡回で再試行）', summarizedAt: now.toISOString() });
    }
  }
  return { ...base, entries, error: failures.length ? `要約失敗: ${failures.join(' / ')}`.slice(0, 400) : null };
}

export async function buildReleaseDigest(
  config: ReleaseWatchConfig,
  previous: ReleaseDigest | null,
  now: Date,
  deps: ReleaseServiceDeps = {},
  onlySourceId?: string,
): Promise<ReleaseDigest> {
  const previousById = new Map((previous?.sources ?? []).map((s) => [s.sourceId, s]));
  const sources: ReleaseSourceDigest[] = [];
  for (const source of config.sources) {
    const prev = previousById.get(source.id) ?? null;
    const skip = !source.enabled || (onlySourceId !== undefined && source.id !== onlySourceId);
    if (skip) {
      if (prev) sources.push(prev);
      continue;
    }
    sources.push(await refreshSource(source, config.versionsPerSource, prev, now, deps));
  }
  // date は「全ソースを巡回し切った日」。 1 ソースだけの更新で今日の日付を立てると
  // scheduler の当日判定 (shouldRefreshReleases) が残りのソースの巡回を丸ごと止めてしまう。
  const date = onlySourceId === undefined ? localDate(now) : (previous?.date ?? null);
  return { date, generatedAt: now.toISOString(), sources };
}

/** 全ソース (または 1 ソース) を巡回して digest を保存する。 */
export async function refreshReleaseDigest(
  db: Db,
  now: Date = new Date(),
  deps: ReleaseServiceDeps = {},
  onlySourceId?: string,
): Promise<ReleaseDigest> {
  const config = getReleaseWatchConfig(db);
  const digest = await buildReleaseDigest(config, getReleaseDigest(db), now, deps, onlySourceId);
  setReleaseDigest(db, digest);
  return digest;
}
