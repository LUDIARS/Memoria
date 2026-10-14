// Wikimedia の閲覧数ランキング (前日分) を順位付きの一覧に変える。
// メインページ・特別ページ・名前空間付きのページは話題ではないので除く。

import type { RawTrendItem } from '../types.js';

/** `https://ja.wikipedia.org` → `ja.wikipedia`。 */
export function wikipediaProject(siteUrl: string): string {
  const host = new URL(siteUrl).hostname;
  const match = host.match(/^([a-z-]+)\.wikipedia\.org$/);
  if (!match) throw new Error(`Wikipedia の URL ではありません: ${siteUrl}`);
  return `${match[1]}.wikipedia`;
}

/** 集計が揃っている前日 (UTC) の日付を `YYYY/MM/DD` で返す。 daysBack で更に遡る。 */
export function wikipediaDatePath(now: Date, daysBack = 1): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysBack));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

export function wikipediaTopUrl(siteUrl: string, now: Date, daysBack = 1): string {
  return `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/${wikipediaProject(siteUrl)}/all-access/${wikipediaDatePath(now, daysBack)}`;
}

const EXCLUDED_TITLES = new Set(['メインページ', 'Main_Page', '-']);

export function isTopicArticle(article: string): boolean {
  return !EXCLUDED_TITLES.has(article) && !article.includes(':');
}

export function parseWikipediaTop(json: string, siteUrl: string, limit: number): RawTrendItem[] {
  let decoded: unknown;
  try { decoded = JSON.parse(json); } catch { throw new Error('Wikipedia ランキングの JSON が読めませんでした'); }
  const articles = (decoded as { items?: { articles?: unknown }[] })?.items?.[0]?.articles;
  if (!Array.isArray(articles)) throw new Error('Wikipedia ランキングに articles がありません');
  const base = new URL(siteUrl).origin;
  const items: RawTrendItem[] = [];
  for (const entry of articles as { article?: unknown; views?: unknown }[]) {
    if (items.length >= limit) break;
    const article = typeof entry?.article === 'string' ? entry.article : '';
    if (!article || !isTopicArticle(article)) continue;
    const views = typeof entry.views === 'number' ? entry.views : null;
    items.push({
      rank: items.length + 1,
      title: article.replace(/_/g, ' ').slice(0, 300),
      subtitle: null,
      url: `${base}/wiki/${encodeURIComponent(article)}`,
      metric: views === null ? null : `${views.toLocaleString('ja-JP')} 閲覧`,
    });
  }
  return items;
}
