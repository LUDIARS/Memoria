import { fetchPublicText } from '../shared/public-fetch.js';
import { parseGithubRepo } from './config.js';
import type { RawRelease, ReleaseSource } from './types.js';

const GITHUB_ACCEPT = 'application/vnd.github+json';
const MAX_BODY_CHARS = 12_000;
const NOTES_MAX_BYTES = 1024 * 1024;
// Releases API は本文込みで 1 件 100KB を超えることがある (Codex の alpha 連投など)。
const API_MAX_BYTES = 24 * 1024 * 1024;

interface GithubReleaseJson {
  tag_name?: string;
  name?: string | null;
  html_url?: string;
  published_at?: string | null;
  created_at?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

interface GithubTagJson {
  name?: string;
}

export type TextFetcher = (url: string, options?: { accept?: string; maxBytes?: number }) => Promise<{ text: string }>;

function matches(source: ReleaseSource, value: string): boolean {
  if (!source.includePattern) return true;
  return new RegExp(source.includePattern).test(value);
}

function githubApiHeaders(): Record<string, string> {
  const token = process.env.MEMORIA_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** トークンを付けてよいのは GitHub 自身の API だけ。 */
function isGithubApiUrl(url: string): boolean {
  try { return new URL(url).hostname === 'api.github.com'; } catch { return false; }
}

// notesUrlTemplate は任意ホストを指せるので、 api.github.com 以外には Authorization を付けない
// (付けると GitHub トークンが第三者サイトへ流出する)。
const defaultFetcher: TextFetcher = (url, o) => fetchPublicText(
  url,
  isGithubApiUrl(url) ? { ...o, extraHeaders: githubApiHeaders() } : o,
);

export function normalizeGithubReleases(source: ReleaseSource, json: unknown): RawRelease[] {
  if (!Array.isArray(json)) throw new Error('GitHub releases response is not an array');
  const out: RawRelease[] = [];
  for (const item of json as GithubReleaseJson[]) {
    const tag = item.tag_name?.trim();
    if (!tag || item.draft || !item.html_url) continue;
    if (!matches(source, tag)) continue;
    out.push({
      version: tag,
      url: item.html_url,
      publishedAt: item.published_at ?? item.created_at ?? null,
      body: (item.body ?? '').slice(0, MAX_BODY_CHARS),
    });
  }
  return out;
}

/** `{tag}` / `{version}` (= 先頭 v を除いたもの) を置換する。 */
export function renderNotesUrl(template: string, tag: string): string {
  const version = tag.replace(/^v/i, '');
  return template.replaceAll('{tag}', encodeURIComponent(tag)).replaceAll('{version}', encodeURIComponent(version));
}

export async function fetchGithubReleases(
  source: ReleaseSource,
  limit: number,
  fetchText: TextFetcher = defaultFetcher,
): Promise<RawRelease[]> {
  const repo = parseGithubRepo(source.url);
  if (!repo) throw new Error('not a github.com repository URL');
  // include 絞り込みで落ちる分を見込んで多めに取る。
  const perPage = Math.min(100, Math.max(limit * 10, 50));
  const api = `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=${perPage}`;
  const { text } = await fetchText(api, { accept: GITHUB_ACCEPT, maxBytes: API_MAX_BYTES });
  return normalizeGithubReleases(source, JSON.parse(text)).slice(0, limit);
}

export async function fetchGithubTags(
  source: ReleaseSource,
  limit: number,
  fetchText: TextFetcher = defaultFetcher,
): Promise<RawRelease[]> {
  const repo = parseGithubRepo(source.url);
  if (!repo) throw new Error('not a github.com repository URL');
  const perPage = Math.min(100, Math.max(limit * 6, 30));
  const api = `https://api.github.com/repos/${repo.owner}/${repo.repo}/tags?per_page=${perPage}`;
  const { text } = await fetchText(api, { accept: GITHUB_ACCEPT, maxBytes: API_MAX_BYTES });
  const json = JSON.parse(text);
  if (!Array.isArray(json)) throw new Error('GitHub tags response is not an array');
  const tags = (json as GithubTagJson[])
    .map((t) => t.name?.trim() ?? '')
    .filter((name) => name && matches(source, name))
    .slice(0, limit);
  const out: RawRelease[] = [];
  for (const tag of tags) {
    let body = '';
    if (source.notesUrlTemplate) {
      try {
        const notes = await fetchText(renderNotesUrl(source.notesUrlTemplate, tag), { accept: 'text/plain,*/*;q=0.5', maxBytes: NOTES_MAX_BYTES });
        body = notes.text.slice(0, MAX_BODY_CHARS);
      } catch (error: unknown) {
        body = `(release notes unavailable: ${error instanceof Error ? error.message : String(error)})`;
      }
    }
    out.push({
      version: tag,
      url: `https://github.com/${repo.owner}/${repo.repo}/releases/tag/${encodeURIComponent(tag)}`,
      publishedAt: null,
      body,
    });
  }
  return out;
}
