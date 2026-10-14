// 取得方式ごとに HTTP を叩いて RawTrendItem[] を返す。 解析は各 *-source.ts の純関数に任せる。
//
// 利用者が URL を変えられる取得 (GET) は SSRF ガード付きの fetchPublicText を通す。
// AniList は固定の公式エンドポイントへの POST なので通常の fetch を使う。

import { fetchPublicText, readBoundedBytes } from '../../shared/public-fetch.js';
import type { RawTrendItem, TrendSource } from '../types.js';
import { ANILIST_ENDPOINT, anilistQuery, parseAnilistTrending } from './anilist-source.js';
import { parseAppleTop } from './apple-source.js';
import { HN_API, parseHnTopIds, toHnItems } from './hackernews-source.js';
import { parseTrendFeed } from './rss-source.js';
import { parseWikipediaTop, wikipediaTopUrl } from './wikipedia-source.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MemoriaTrendCrawler/1.0';
const JSON_ACCEPT = 'application/json, */*;q=0.5';
const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5';
const POST_TIMEOUT_MS = 20_000;
const POST_MAX_BYTES = 2 * 1024 * 1024;

export type TextGetter = (url: string, accept: string) => Promise<string>;
export type JsonPoster = (url: string, body: string) => Promise<string>;

export interface FetchSourceDeps {
  get?: TextGetter;
  post?: JsonPoster;
  now?: Date;
}

const defaultGet: TextGetter = async (url, accept) => (await fetchPublicText(url, { accept, userAgent: USER_AGENT })).text;

const defaultPost: JsonPoster = async (url, body) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
      body,
    });
    const bytes = await readBoundedBytes(response, POST_MAX_BYTES);
    const text = new TextDecoder('utf-8').decode(bytes);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
};

async function fetchWikipedia(source: TrendSource, limit: number, get: TextGetter, now: Date): Promise<RawTrendItem[]> {
  // 前日分の集計が未公開 (404) のことがあるので 1 日だけ遡って再試行する。
  try {
    return parseWikipediaTop(await get(wikipediaTopUrl(source.url, now, 1), JSON_ACCEPT), source.url, limit);
  } catch (error: unknown) {
    if (!(error instanceof Error) || !/HTTP 404/.test(error.message)) throw error;
    return parseWikipediaTop(await get(wikipediaTopUrl(source.url, now, 2), JSON_ACCEPT), source.url, limit);
  }
}

async function fetchHackerNews(limit: number, get: TextGetter): Promise<RawTrendItem[]> {
  const ids = parseHnTopIds(await get(`${HN_API}/topstories.json`, JSON_ACCEPT), limit);
  const items = await Promise.all(ids.map(async (id) => {
    try { return JSON.parse(await get(`${HN_API}/item/${id}.json`, JSON_ACCEPT)) as Record<string, unknown> | null; } catch { return null; }
  }));
  return toHnItems(items);
}

export async function fetchTrendSource(source: TrendSource, limit: number, deps: FetchSourceDeps = {}): Promise<RawTrendItem[]> {
  const get = deps.get ?? defaultGet;
  const post = deps.post ?? defaultPost;
  const now = deps.now ?? new Date();
  switch (source.kind) {
    case 'rss': return parseTrendFeed(await get(source.url, FEED_ACCEPT), limit);
    case 'apple_top': return parseAppleTop(await get(source.url, JSON_ACCEPT), limit);
    case 'wikipedia_top': return fetchWikipedia(source, limit, get, now);
    case 'anilist_anime': return parseAnilistTrending(await post(ANILIST_ENDPOINT, anilistQuery('ANIME', limit)), limit);
    case 'anilist_manga': return parseAnilistTrending(await post(ANILIST_ENDPOINT, anilistQuery('MANGA', limit)), limit);
    case 'hn_top': return fetchHackerNews(limit, get);
  }
}
