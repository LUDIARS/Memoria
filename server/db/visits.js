import { extractDomain, firstPathSegment } from './_helpers.js';

/** Upsert a visit row for any URL (whether bookmarked or not). */
export function upsertVisit(db, { url, title }) {
  db.prepare(`
    INSERT INTO page_visits (url, title)
    VALUES (?, ?)
    ON CONFLICT(url) DO UPDATE SET
      title = COALESCE(NULLIF(excluded.title, ''), page_visits.title),
      last_seen_at = datetime('now'),
      visit_count = page_visits.visit_count + 1
  `).run(url, title ?? null);
}

/**
 * URLs visited today (local time) that are NOT yet bookmarked.
 * `since` is an optional ISO string lower bound; default = start of local day.
 */
export function listUnsavedVisits(db, { since } = {}) {
  const sinceClause = since
    ? `v.last_seen_at >= ?`
    : `date(v.last_seen_at, 'localtime') = date('now', 'localtime')`;
  const args = since ? [since] : [];
  return db.prepare(`
    SELECT v.url, v.title, v.first_seen_at, v.last_seen_at, v.visit_count
    FROM page_visits v
    LEFT JOIN bookmarks b ON b.url = v.url
    WHERE b.id IS NULL
      AND ${sinceClause}
    ORDER BY v.last_seen_at DESC
  `).all(...args);
}

export function deleteVisit(db, url) {
  db.prepare(`DELETE FROM page_visits WHERE url = ?`).run(url);
}

/**
 * Unsaved visits enriched with domain stats and a "miss-bookmark likelihood" score.
 * The intent is to surface URLs that the user is probably reading but hasn't bookmarked
 * because the same domain (or path prefix) is already in their library.
 */
export function listSuggestedVisits(db, { sinceDays = 30 } = {}) {
  const visits = db.prepare(`
    SELECT v.url, v.title, v.first_seen_at, v.last_seen_at, v.visit_count
    FROM page_visits v
    LEFT JOIN bookmarks b ON b.url = v.url
    WHERE b.id IS NULL
      AND v.last_seen_at >= datetime('now', ?)
    ORDER BY v.last_seen_at DESC
  `).all(`-${Number(sinceDays) || 30} days`);

  const bookmarkUrls = db.prepare(`SELECT url FROM bookmarks`).all().map(r => r.url);
  const domainCounts = new Map();
  const pathPrefixIndex = new Map();
  for (const u of bookmarkUrls) {
    const d = extractDomain(u);
    if (!d) continue;
    domainCounts.set(d, (domainCounts.get(d) || 0) + 1);
    const segs = firstPathSegment(u);
    if (segs) {
      if (!pathPrefixIndex.has(d)) pathPrefixIndex.set(d, new Set());
      pathPrefixIndex.get(d).add(segs);
    }
  }

  return visits.map(v => {
    const domain = extractDomain(v.url);
    const firstSeg = firstPathSegment(v.url);
    const sameDomain = domain ? (domainCounts.get(domain) || 0) : 0;
    const samePrefix = (domain && firstSeg && pathPrefixIndex.get(domain)?.has(firstSeg)) ? 1 : 0;
    const score = sameDomain * 10 + samePrefix * 8 + Math.min(v.visit_count || 1, 20) * 2;
    return {
      ...v,
      domain,
      same_domain_bookmarks: sameDomain,
      same_path_prefix_bookmarks: samePrefix,
      score,
    };
  }).sort((a, b) => b.score - a.score || (a.last_seen_at < b.last_seen_at ? 1 : -1));
}

export function insertVisitEvent(db, { url, title }) {
  const domain = extractDomain(url);
  db.prepare(`
    INSERT INTO visit_events (url, domain, title) VALUES (?, ?, ?)
  `).run(url, domain, title ?? null);
}

/** Visit events for a single local date (YYYY-MM-DD). */
export function visitEventsForDate(db, dateStr) {
  return db.prepare(`
    SELECT id, url, domain, title, visited_at
    FROM visit_events
    WHERE date(visited_at, 'localtime') = ?
    ORDER BY visited_at ASC
  `).all(dateStr);
}
