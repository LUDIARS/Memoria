// Site recommendations: extract outbound links from saved HTML pages, drop
// anything already saved/visited/dismissed, score by how many of the user's
// pages link to a given URL. The base score is then biased by:
//   - frequently-visited site domains (page_visits log, including non-saved)
//   - word-cloud overlap with recent bookmark word clouds
//
// Result is cached in memory for `CACHE_TTL_MS` to avoid re-walking 100s of
// HTML files on every refresh. Dismissals invalidate the cache.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseHtml } from 'node-html-parser';
import { trendsVisitDomains, recentBookmarkWordClouds } from './db.js';

const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_SOURCE_DOCS = 250;
const MAX_RESULTS = 100;
const PER_DOC_LINK_CAP = 80; // an article with 5000 links is almost always a navigation page

let cache = { computedAt: 0, dismissalSig: '', items: [] };

export function recommendationsFor(db, htmlDir, { force = false } = {}) {
  const dismissed = db.prepare(`SELECT url FROM recommendation_dismissals`).all().map(r => r.url);
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

export function dismissRecommendation(db, url) {
  db.prepare(`INSERT OR IGNORE INTO recommendation_dismissals (url) VALUES (?)`).run(url);
  cache = { computedAt: 0, dismissalSig: '', items: [] };
}

export function clearDismissals(db) {
  db.prepare(`DELETE FROM recommendation_dismissals`).run();
  cache = { computedAt: 0, dismissalSig: '', items: [] };
}

function compute(db, htmlDir, dismissed) {
  const sources = db.prepare(`
    SELECT id, url, title, html_path, created_at FROM bookmarks
    ORDER BY created_at DESC
    LIMIT ?
  `).all(MAX_SOURCE_DOCS);
  const savedUrls = new Set(db.prepare(`SELECT url FROM bookmarks`).all().map(r => r.url));
  const visitedUrls = new Set(db.prepare(`SELECT url FROM page_visits`).all().map(r => r.url));

  // Frequently-visited domains (URL log, regardless of bookmark status). Used
  // as a multiplicative boost on candidates that share a domain with the user's
  // habitual sites.
  const visitDomains = trendsVisitDomains(db, { sinceDays: 60, limit: 50 });
  const visitDomainBoost = new Map();
  if (visitDomains.length > 0) {
    const max = Math.max(...visitDomains.map(d => d.visits));
    for (const d of visitDomains) {
      // 0..1, then mapped to 1..3 multiplier.
      visitDomainBoost.set(d.domain, 1 + 2 * (d.visits / Math.max(max, 1)));
    }
  }

  // Recent bookmark word clouds — kept words form a topic vocabulary; anchor
  // text overlap with these words boosts candidates.
  const recentClouds = recentBookmarkWordClouds(db, { limit: 30 });
  const topicWords = new Map(); // word -> aggregated weight
  for (const c of recentClouds) {
    const ws = c.result?.words || [];
    for (const w of ws) {
      if (!w.kept) continue;
      const key = String(w.word || '').toLowerCase();
      if (!key) continue;
      topicWords.set(key, (topicWords.get(key) || 0) + (w.weight || 1));
    }
  }
  const topicMaxWeight = Math.max(1, ...topicWords.values());

  const linkStats = new Map(); // url -> { count, sources: Map<bookmarkId, {title}>, anchor }

  for (const b of sources) {
    let html;
    try { html = readFileSync(join(htmlDir, b.html_path), 'utf8'); } catch { continue; }

    const root = parseHtml(html, { lowerCaseTagName: false });
    const anchors = root.querySelectorAll('a[href]');
    if (!anchors || anchors.length === 0) continue;

    const seen = new Set();
    let added = 0;
    for (const a of anchors) {
      if (added >= PER_DOC_LINK_CAP) break;
      const href = a.getAttribute('href');
      if (!href) continue;
      let abs;
      try { abs = stripFragmentAndQuery(new URL(href, b.url).href); } catch { continue; }
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
    .map(([url, s]) => {
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

function scoreTopicOverlap(anchor, topicWords, maxWeight) {
  if (!anchor || topicWords.size === 0) return 0;
  const text = anchor.toLowerCase();
  let hit = 0;
  for (const [word, weight] of topicWords) {
    if (word.length < 2) continue;
    if (text.includes(word)) hit += weight / maxWeight;
  }
  return hit;
}

function stripFragmentAndQuery(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    // Drop tracking-style query strings while keeping legitimate ones short.
    const params = [...u.searchParams.entries()].filter(([k]) => !/^utm_|fbclid|gclid|ref|source/i.test(k));
    u.search = '';
    if (params.length > 0) {
      const sp = new URLSearchParams(params);
      u.search = '?' + sp.toString();
    }
    return u.href;
  } catch { return url; }
}

function domainOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}
function sameDomain(a, b) {
  const da = domainOf(a), db_ = domainOf(b);
  if (!da || !db_) return false;
  return da === db_ || da.endsWith('.' + db_) || db_.endsWith('.' + da);
}
