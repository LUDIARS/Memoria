// Apple のランキング JSON (rss.marketingtools.apple.com) を順位付きの一覧に変える。

import type { RawTrendItem } from '../types.js';

interface AppleResult {
  name?: unknown;
  artistName?: unknown;
  url?: unknown;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseAppleTop(json: string, limit: number): RawTrendItem[] {
  let decoded: unknown;
  try { decoded = JSON.parse(json); } catch { throw new Error('Apple ランキングの JSON が読めませんでした'); }
  const results = (decoded as { feed?: { results?: unknown } })?.feed?.results;
  if (!Array.isArray(results)) throw new Error('Apple ランキングに results がありません');
  const items: RawTrendItem[] = [];
  for (const result of results as AppleResult[]) {
    if (items.length >= limit) break;
    const title = str(result?.name);
    if (!title) continue;
    const url = str(result.url);
    items.push({
      rank: items.length + 1,
      title: title.slice(0, 300),
      subtitle: str(result.artistName) || null,
      url: url.startsWith('https://') ? url : null,
      metric: null,
    });
  }
  return items;
}
