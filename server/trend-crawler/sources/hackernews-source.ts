// Hacker News 公式 API (hacker-news.firebaseio.com) の topstories を順位付きの一覧に変える。

import type { RawTrendItem } from '../types.js';

export const HN_API = 'https://hacker-news.firebaseio.com/v0';

export function parseHnTopIds(json: string, limit: number): number[] {
  let decoded: unknown;
  try { decoded = JSON.parse(json); } catch { throw new Error('Hacker News の topstories が JSON ではありません'); }
  if (!Array.isArray(decoded)) throw new Error('Hacker News の topstories が配列ではありません');
  return decoded.filter((id): id is number => Number.isInteger(id)).slice(0, limit);
}

interface HnItem {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  score?: unknown;
  descendants?: unknown;
}

/** 取れた item だけを並び順のまま順位付けする (null は取得失敗・削除済み)。 */
export function toHnItems(items: (HnItem | null)[]): RawTrendItem[] {
  const out: RawTrendItem[] = [];
  for (const item of items) {
    const title = typeof item?.title === 'string' ? item.title.trim() : '';
    if (!item || !title) continue;
    const id = Number.isInteger(item.id) ? Number(item.id) : null;
    const link = typeof item.url === 'string' && /^https?:\/\//.test(item.url)
      ? item.url
      : (id === null ? null : `https://news.ycombinator.com/item?id=${id}`);
    const score = typeof item.score === 'number' ? item.score : null;
    const comments = typeof item.descendants === 'number' ? item.descendants : null;
    const metric = [score === null ? '' : `${score} points`, comments === null ? '' : `${comments} comments`].filter(Boolean).join(' · ');
    out.push({ rank: out.length + 1, title: title.slice(0, 300), subtitle: null, url: link, metric: metric || null });
  }
  return out;
}
