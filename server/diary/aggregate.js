// Aggregate a single day's data (visits, bookmarks, digs, downtimes,
// GPS, meals, caloric balance) into a single metrics object that powers
// both the diary view and the prompt builders.

import {
  visitEventsForDate,
  getDomainCatalogMap,
  digSessionsForDate,
  listServerEventsForDate,
  listGpsLocationsForDate,
  listMealsForDate,
} from '../db.js';
import { extractDomain } from './date.js';
import { parseSqliteUtc, summarizeGpsForDate } from './gps.js';
import { computeCaloricBalance } from './nutrition.js';

// Downtimes >5 min make it into the diary; shorter gaps are treated as
// restarts (e.g. process kill + npm start) and silently ignored.
const DIARY_DOWNTIME_THRESHOLD_MS = 5 * 60 * 1000;

// Initial page size for the bookmark / dig lists in the diary view.
// Anything beyond this is loaded on-demand via the per-list endpoints.
const DIARY_LIST_INITIAL = 10;

/**
 * Aggregate the day from BOTH sources together (no URL-level dedup).
 * - visit_events: per-event log. 1 row = 1 hit at its precise hour.
 * - page_visits:  per-URL row touched today. 1 row = 1 hit at last_seen_at's hour.
 * Overlap between the two sources is intentional — when a URL appears in both,
 * that signals "heavy activity on that URL" (touched many times today, plus
 * still present in the per-URL touch table).
 */
export function aggregateDay(db, dateStr, { listLimit = DIARY_LIST_INITIAL } = {}) {
  const hourlyVisits = new Array(24).fill(0);
  const domainTally = new Map();
  const domainHours = new Map(); // domain -> Set of hour buckets seen
  let firstSeen = null;
  let lastSeen = null;

  // 1) Per-event log
  const events = visitEventsForDate(db, dateStr);
  for (const e of events) {
    const localHour = parseSqliteUtc(e.visited_at)?.getHours();
    const hour = Number.isFinite(localHour) ? localHour : 0;
    hourlyVisits[hour] += 1;
    if (!firstSeen || e.visited_at < firstSeen) firstSeen = e.visited_at;
    if (!lastSeen || e.visited_at > lastSeen) lastSeen = e.visited_at;
    if (e.domain) {
      domainTally.set(e.domain, (domainTally.get(e.domain) || 0) + 1);
      if (!domainHours.has(e.domain)) domainHours.set(e.domain, new Set());
      domainHours.get(e.domain).add(hour);
    }
  }

  // 2) Per-URL log (page_visits) — every URL touched on this date adds another hit.
  const visits = db.prepare(`
    SELECT v.url, v.last_seen_at
    FROM page_visits v
    WHERE date(v.last_seen_at, 'localtime') = ?
  `).all(dateStr);
  let pageVisitsContribution = 0;
  for (const v of visits) {
    const domain = extractDomain(v.url);
    if (!domain) continue;
    let hour = 0;
    try {
      hour = parseSqliteUtc(v.last_seen_at)?.getHours();
      if (!Number.isFinite(hour)) hour = 0;
    } catch {}
    hourlyVisits[hour] += 1;
    pageVisitsContribution += 1;
    domainTally.set(domain, (domainTally.get(domain) || 0) + 1);
    if (!domainHours.has(domain)) domainHours.set(domain, new Set());
    domainHours.get(domain).add(hour);
    if (!firstSeen || v.last_seen_at < firstSeen) firstSeen = v.last_seen_at;
    if (!lastSeen || v.last_seen_at > lastSeen) lastSeen = v.last_seen_at;
  }

  const topDomainList = [...domainTally.entries()]
    .map(([domain, count]) => ({
      domain,
      count,
      active_hours: [...(domainHours.get(domain) || [])].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  const catalog = getDomainCatalogMap(db, topDomainList.map(d => d.domain));
  const topDomains = topDomainList.map(d => {
    const cat = catalog.get(d.domain);
    return cat ? {
      ...d,
      site_name: cat.site_name || null,
      description: cat.description || null,
      can_do: cat.can_do || null,
      kind: cat.kind || null,
      catalog_title: cat.title || null,
    } : d;
  });

  const activeHours = hourlyVisits
    .map((n, h) => ({ hour: h, count: n }))
    .filter(b => b.count > 0)
    .map(b => b.hour);

  const totalEvents = hourlyVisits.reduce((s, n) => s + n, 0);

  // Bookmark + dig lists are paginated for the live response. The
  // highlights prompt builder calls aggregateDay() with `listLimit: null`
  // so claude still sees the full picture.
  const bookmarks = bookmarksForDate(db, dateStr,
    listLimit == null ? {} : { limit: listLimit, offset: 0 });
  const allDigs = digSessionsForDate(db, dateStr);
  const digsTotal = allDigs.length;
  const digSlice = listLimit == null ? allDigs : allDigs.slice(0, listLimit);
  const digs = digSlice.map(d => {
    const r = d.result || {};
    return {
      id: d.id,
      query: d.query,
      status: d.status,
      created_at: d.created_at,
      summary: (r.summary || '').slice(0, 600),
      source_count: (r.sources || []).length,
      sources: (r.sources || []).slice(0, 8).map(s => ({
        url: s.url, title: s.title, snippet: (s.snippet || '').slice(0, 200),
      })),
    };
  });

  // Surface significant server downtimes so claude knows the data is partial.
  const serverEvents = listServerEventsForDate(db, dateStr);
  const downtimes = serverEvents
    .filter(e => e.type === 'downtime' && (e.duration_ms || 0) > DIARY_DOWNTIME_THRESHOLD_MS)
    .map(e => ({
      from: e.occurred_at,
      to: e.ended_at,
      duration_ms: e.duration_ms,
    }));
  const totalDowntimeMs = downtimes.reduce((s, d) => s + (d.duration_ms || 0), 0);

  // GPS — OwnTracks 由来の歩いた軌跡を当日分集計する。
  // ポイント数と概算距離 + bbox + アクティブ時間帯を出す。
  // クラスタリング (場所推定) はやらない (静止判定が難しく、誤推定すると
  // 日記の根拠が壊れるため)。代わりに raw 距離 + 中央付近の代表点で示す。
  const gpsPoints = listGpsLocationsForDate(db, dateStr);
  const gps = summarizeGpsForDate(gpsPoints);

  // 食事ログ — eaten_at がその日に該当する meal をすべて拾う。
  // 総カロリーは「base (user_corrected_calories ?? calories) + sum(additions[].calories)」 を
  // 各レコードで計算した合計。 calories null 値は 0 として扱う (ユーザが
  // 不明としたものを過大計上しないため、 集計上は欠損扱い)。
  const mealsRows = listMealsForDate(db, dateStr);
  const meals = mealsRows.map((m) => {
    const additions = parseMealAdditions(m.additions_json);
    const baseCal = (typeof m.user_corrected_calories === 'number') ? m.user_corrected_calories
      : (typeof m.calories === 'number') ? m.calories : null;
    const addCalSum = additions.reduce(
      (s, a) => s + (typeof a.calories === 'number' && isFinite(a.calories) ? a.calories : 0), 0,
    );
    const totalCal = (baseCal == null && additions.length === 0)
      ? null
      : (baseCal ?? 0) + addCalSum;
    return {
      id: m.id,
      eaten_at: m.eaten_at,
      description: m.user_corrected_description || m.description || null,
      base_calories: baseCal,
      addition_calories: addCalSum,
      total_calories: totalCal,
      nutrients: parseMealNutrients(m.nutrients_json),
      additions: additions.map((a) => ({
        name: a.name,
        calories: typeof a.calories === 'number' ? a.calories : null,
        added_at: a.added_at || null,
      })),
      location_label: m.location_label || null,
      ai_status: m.ai_status,
      user_note: m.user_note || null,
    };
  });
  const mealsCalories = meals.reduce(
    (s, m) => s + (typeof m.total_calories === 'number' ? m.total_calories : 0), 0,
  );
  // 栄養素合計 — null は 0 として加算しない (= 計上しない)、 ある食事のみ合計
  const nutrientKeys = ['protein_g', 'fat_g', 'carbs_g', 'fiber_g', 'sugar_g', 'sodium_mg'];
  const nutrientsSum = Object.fromEntries(nutrientKeys.map((k) => [k, 0]));
  let nutrientsAnyMeal = false;
  for (const m of meals) {
    if (!m.nutrients) continue;
    nutrientsAnyMeal = true;
    for (const k of nutrientKeys) {
      const v = m.nutrients[k];
      if (typeof v === 'number' && isFinite(v)) nutrientsSum[k] += v;
    }
  }
  // PFC バランスの簡易ラベル (3 大栄養素 g → kcal 比換算)
  let pfcLabel = null;
  if (nutrientsAnyMeal) {
    const pCal = (nutrientsSum.protein_g || 0) * 4;
    const fCal = (nutrientsSum.fat_g || 0) * 9;
    const cCal = (nutrientsSum.carbs_g || 0) * 4;
    const sum = pCal + fCal + cCal;
    if (sum > 0) {
      const pPct = Math.round((pCal / sum) * 100);
      const fPct = Math.round((fCal / sum) * 100);
      const cPct = 100 - pPct - fPct;
      pfcLabel = `P:${pPct}% / F:${fPct}% / C:${cPct}%`;
    }
  }

  return {
    date: dateStr,
    total_events: totalEvents,
    unique_domains: domainTally.size,
    hourly_visits: hourlyVisits,
    top_domains: topDomains,
    active_hours: activeHours,
    first_event_at: firstSeen,
    last_event_at: lastSeen,
    bookmarks,
    digs,
    digs_total: digsTotal,
    downtimes,
    total_downtime_ms: totalDowntimeMs,
    gps,
    meals,
    meals_total_calories: meals.length > 0 ? mealsCalories : null,
    meals_nutrients: nutrientsAnyMeal ? nutrientsSum : null,
    meals_pfc_label: pfcLabel,
    caloric_balance: computeCaloricBalance(db, {
      intake: meals.length > 0 ? mealsCalories : null,
      gpsDistanceM: gps?.distance_m ?? 0,
    }),
    sources: {
      visit_events: events.length,
      page_visits: pageVisitsContribution,
    },
  };
}

export function parseMealAdditions(json) {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function parseMealNutrients(json) {
  if (!json) return null;
  try {
    const o = JSON.parse(json);
    return (o && typeof o === 'object') ? o : null;
  } catch {
    return null;
  }
}

/** Bookmarks created or accessed on `dateStr`. */
// Per-day bookmark lists used by the diary view. `limit/offset` paginate;
// `null` limit returns everything (used by the highlights prompt builder
// inside aggregateDay so claude still sees the full picture).
export function bookmarksForDate(db, dateStr, { limit = null, offset = 0 } = {}) {
  const limitClause = limit == null ? '' : ' LIMIT ? OFFSET ?';
  const args = limit == null ? [dateStr] : [dateStr, Number(limit) || 0, Number(offset) || 0];

  const createdTotal = db.prepare(`
    SELECT COUNT(*) AS n FROM bookmarks WHERE date(created_at, 'localtime') = ?
  `).get(dateStr).n;
  const created = db.prepare(`
    SELECT id, url, title, summary, created_at
    FROM bookmarks
    WHERE date(created_at, 'localtime') = ?
    ORDER BY created_at ASC
    ${limitClause}
  `).all(...args);

  const accessedTotal = db.prepare(`
    SELECT COUNT(DISTINCT b.id) AS n
    FROM accesses a
    JOIN bookmarks b ON b.id = a.bookmark_id
    WHERE date(a.accessed_at, 'localtime') = ?
  `).get(dateStr).n;
  const accessedRows = db.prepare(`
    SELECT b.id, b.url, b.title,
           MIN(a.accessed_at) AS first_accessed_at,
           MAX(a.accessed_at) AS last_accessed_at,
           COUNT(*) AS access_count
    FROM accesses a
    JOIN bookmarks b ON b.id = a.bookmark_id
    WHERE date(a.accessed_at, 'localtime') = ?
    GROUP BY b.id
    ORDER BY access_count DESC, last_accessed_at DESC
    ${limitClause}
  `).all(...args);

  return {
    created, accessed: accessedRows,
    created_total: createdTotal,
    accessed_total: accessedTotal,
  };
}
