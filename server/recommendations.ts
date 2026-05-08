// Site recommendations: extract outbound links from saved HTML pages, drop
// anything already saved/visited/dismissed, score by how many of the user's
// pages link to a given URL. The base score is then biased by:
//   - frequently-visited site domains (page_visits log, including non-saved)
//   - word-cloud overlap with recent bookmark word clouds

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { parse as parseHtml } from 'node-html-parser';
import { trendsVisitDomains, recentBookmarkWordClouds } from './db.js';

type Db = BetterSqlite3.Database;

const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_SOURCE_DOCS = 250;
const MAX_RESULTS = 100;
const PER_DOC_LINK_CAP = 80;

export interface RecommendationItem {
  url: string;
  domain: string;
  count: number;
  source_count: number;
  anchor: string;
  sources: { id: number; title: string }[];
  domain_boost: number;
  topic_hits: number;
  score: number;
}

interface CacheState {
  computedAt: number;
  dismissalSig: string;
  items: RecommendationItem[];
}

let cache: CacheState = { computedAt: 0, dismissalSig: '', items: [] };

interface SourceBookmark {
  id: number;
  url: string;
  title: string;
  html_path: string;
  created_at: string;
}

interface VisitDomainRow { domain: string; visits: number }
interface BookmarkWordCloudRow { result?: { words?: { word?: unknown; weight?: unknown; kept?: unknown }[] } | null }

export function recommendationsFor(
  db: Db,
  htmlDir: string,
  { force = false }: { force?: boolean } = {},
): RecommendationItem[] {
  const dismissed = (db.prepare(`SELECT url FROM recommendation_dismissals`).all() as { url: string }[]).map(r => r.url);
  const sig = String(dismissed.length) + '|' + (dismissed[0] ?? '') + '|' + (dismissed.at(-1) ?? '');
  if (!force
      && cache.computedAt
      && Date.now() - cache.computedAt < CACHE_TTL_MS
      && cache.dismissalSig === sig) {
    return cache.items;
  }
  const items = compute(db, htmlDir, new Set(dismissed));
  cache = { computedAt: Date.now(), dismissalSig: sig, items };
  return items;
}

export function dismissRecommendation(db: Db, url: string): void {
  db.prepare(`INSERT OR IGNORE INTO recommendation_dismissals (url) VALUES (?)`).run(url);
  cache = { computedAt: 0, dismissalSig: '', items: [] };
}

export function clearDismissals(db: Db): void {
  db.prepare(`DELETE FROM recommendation_dismissals`).run();
  cache = { computedAt: 0, dismissalSig: '', items: [] };
}

function compute(db: Db, htmlDir: string, dismissed: Set<string>): RecommendationItem[] {
  const sources = db.prepare(`
    SELECT id, url, title, html_path, created_at FROM bookmarks
    ORDER BY created_at DESC
    LIMIT ?
  `).all(MAX_SOURCE_DOCS) as SourceBookmark[];
  const savedUrls = new Set((db.prepare(`SELECT url FROM bookmarks`).all() as { url: string }[]).map(r => r.url));
  const visitedUrls = new Set((db.prepare(`SELECT url FROM page_visits`).all() as { url: string }[]).map(r => r.url));

  const visitDomains = trendsVisitDomains(db, { sinceDays: 60, limit: 50 }) as VisitDomainRow[];
  const visitDomainBoost = new Map<string, number>();
  if (visitDomains.length > 0) {
    const max = Math.max(...visitDomains.map(d => d.visits));
    for (const d of visitDomains) {
      visitDomainBoost.set(d.domain, 1 + 2 * (d.visits / Math.max(max, 1)));
    }
  }

  const recentClouds = recentBookmarkWordClouds(db, { limit: 30 }) as BookmarkWordCloudRow[];
  const topicWords = new Map<string, number>();
  for (const c of recentClouds) {
    const ws = c.result?.words || [];
    for (const w of ws) {
      if (w.kept === false) continue;
      const key = String(w.word || '').toLowerCase();
      if (!key) continue;
      topicWords.set(key, (topicWords.get(key) || 0) + (Number(w.weight) || 1));
    }
  }
  const topicMaxWeight = Math.max(1, ...topicWords.values());

  interface LinkStat {
    count: number;
    sources: Map<number, { id: number; title: string }>;
    anchor: string;
  }
  const linkStats = new Map<string, LinkStat>();

  for (const b of sources) {
    let html: string;
    try {
      html = readFileSync(join(htmlDir, b.html_path), 'utf8');
    } catch {
      continue;
    }

    const root = parseHtml(html, { lowerCaseTagName: false });
    const anchors = root.querySelectorAll('a[href]');
    if (!anchors || anchors.length === 0) continue;

    const seen = new Set<string>();
    let added = 0;
    for (const a of anchors) {
      if (added >= PER_DOC_LINK_CAP) break;
      const href = a.getAttribute('href');
      if (!href) continue;
      let abs: string;
      try {
        abs = stripFragmentAndQuery(new URL(href, b.url).href);
      } catch {
        continue;
      }
      if (!/^https?:\/\//.test(abs)) continue;
      if (sameDomain(abs, b.url)) continue;
      if (savedUrls.has(abs) || visitedUrls.has(abs) || dismissed.has(abs)) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);

      let stat = linkStats.get(abs);
      if (!stat) {
        stat = { count: 0, sources: new Map(), anchor: '' };
        linkStats.set(abs, stat);
      }
      stat.count++;
      if (!stat.sources.has(b.id)) {
        stat.sources.set(b.id, { id: b.id, title: b.title });
      }
      if (!stat.anchor) stat.anchor = (a.text || '').trim().replace(/\s+/g, ' ').slice(0, 200);
      added++;
    }
  }

  return [...linkStats.entries()]
    .map(([url, s]): RecommendationItem => {
      const domain = domainOf(url);
      const base = s.sources.size * 10 + s.count;
      const domainMul = visitDomainBoost.get(domain) ?? 1;
      const topicHit = scoreTopicOverlap(s.anchor, topicWords, topicMaxWeight);
      const score = Math.round(base * domainMul + topicHit * 6);
      return {
        url,
        domain,
        count: s.count,
        source_count: s.sources.size,
        anchor: s.anchor,
        sources: [...s.sources.values()].slice(0, 5),
        domain_boost: Number(domainMul.toFixed(2)),
        topic_hits: Number(topicHit.toFixed(2)),
        score,
      };
    })
    .filter(r => r.source_count >= 2 || r.count >= 3 || r.domain_boost > 1.2 || r.topic_hits > 0)
    .sort((a, b) => b.score - a.score || b.source_count - a.source_count)
    .slice(0, MAX_RESULTS);
}

function scoreTopicOverlap(anchor: string, topicWords: Map<string, number>, maxWeight: number): number {
  if (!anchor || topicWords.size === 0) return 0;
  const text = anchor.toLowerCase();
  let hit = 0;
  for (const [word, weight] of topicWords) {
    if (word.length < 2) continue;
    if (text.includes(word)) hit += weight / maxWeight;
  }
  return hit;
}

function stripFragmentAndQuery(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    const params = [...u.searchParams.entries()].filter(([k]) => !/^utm_|fbclid|gclid|ref|source/i.test(k));
    u.search = '';
    if (params.length > 0) {
      const sp = new URLSearchParams(params);
      u.search = '?' + sp.toString();
    }
    return u.href;
  } catch {
    return url;
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function sameDomain(a: string, b: string): boolean {
  const da = domainOf(a), db_ = domainOf(b);
  if (!da || !db_) return false;
  return da === db_ || da.endsWith('.' + db_) || db_.endsWith('.' + da);
}
