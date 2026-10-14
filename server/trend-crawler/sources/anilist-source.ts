// AniList GraphQL (https://graphql.anilist.co) の TRENDING 順を順位付きの一覧に変える。

import type { RawTrendItem } from '../types.js';

export const ANILIST_ENDPOINT = 'https://graphql.anilist.co';

export type AnilistMediaType = 'ANIME' | 'MANGA';

export function anilistQuery(type: AnilistMediaType, limit: number): string {
  return JSON.stringify({
    query: 'query ($perPage: Int, $type: MediaType) { Page(perPage: $perPage) { media(sort: TRENDING_DESC, type: $type, isAdult: false) { title { native romaji english } siteUrl trending popularity } } }',
    variables: { perPage: Math.min(Math.max(limit, 1), 50), type },
  });
}

interface AnilistMedia {
  title?: { native?: unknown; romaji?: unknown; english?: unknown };
  siteUrl?: unknown;
  trending?: unknown;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseAnilistTrending(json: string, limit: number): RawTrendItem[] {
  let decoded: unknown;
  try { decoded = JSON.parse(json); } catch { throw new Error('AniList の応答が JSON ではありません'); }
  const body = decoded as { data?: { Page?: { media?: unknown } }; errors?: { message?: unknown }[] };
  if (Array.isArray(body?.errors) && body.errors.length) {
    throw new Error(`AniList: ${str(body.errors[0]?.message) || 'error'}`);
  }
  const media = body?.data?.Page?.media;
  if (!Array.isArray(media)) throw new Error('AniList の応答に media がありません');
  const items: RawTrendItem[] = [];
  for (const entry of media as AnilistMedia[]) {
    if (items.length >= limit) break;
    const native = str(entry?.title?.native);
    const romaji = str(entry?.title?.romaji);
    const english = str(entry?.title?.english);
    const title = native || romaji || english;
    if (!title) continue;
    const siteUrl = str(entry.siteUrl);
    const trending = typeof entry.trending === 'number' ? entry.trending : null;
    items.push({
      rank: items.length + 1,
      title: title.slice(0, 300),
      subtitle: (native && (english || romaji)) ? (english || romaji).slice(0, 300) : null,
      url: siteUrl.startsWith('https://anilist.co/') ? siteUrl : null,
      metric: trending === null ? null : `trend ${trending}`,
    });
  }
  return items;
}
