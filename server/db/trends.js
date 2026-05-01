import { extractDomain } from './_helpers.js';

/**
 * Top domains across the page_visits log (URL-only history),
 * regardless of whether the URL is bookmarked.
 */
export function trendsVisitDomains(db, { sinceDays = 30, limit = 12 } = {}) {
  const rows = db.prepare(`
    SELECT v.url, v.visit_count, v.last_seen_at
    FROM page_visits v
    WHERE v.last_seen_at >= datetime('now', ?)
  `).all(`-${Number(sinceDays) || 30} days`);
  const tally = new Map();
  for (const r of rows) {
    const d = extractDomain(r.url);
    if (!d) continue;
    const cur = tally.get(d) || { domain: d, visits: 0, urls: 0, last_seen_at: '' };
    cur.visits += r.visit_count || 1;
    cur.urls += 1;
    if (!cur.last_seen_at || r.last_seen_at > cur.last_seen_at) cur.last_seen_at = r.last_seen_at;
    tally.set(d, cur);
  }
  return [...tally.values()]
    .sort((a, b) => b.visits - a.visits || b.urls - a.urls)
    .slice(0, Number(limit) || 12);
}

// ── trends -----------------------------------------------------------------

/** Top categories by save count within `sinceDays`. */
export function trendsCategories(db, { sinceDays = 30, limit = 12 } = {}) {
  return db.prepare(`
    SELECT bc.category, COUNT(*) AS count
    FROM bookmark_categories bc
    JOIN bookmarks b ON b.id = bc.bookmark_id
    WHERE b.created_at >= datetime('now', ?)
    GROUP BY bc.category
    ORDER BY count DESC
    LIMIT ?
  `).all(`-${Number(sinceDays) || 30} days`, Number(limit) || 12);
}

/**
 * Compare category counts in the current window with the previous window of
 * the same length. Returns categories with the largest absolute delta.
 */
export function trendsCategoryDiff(db, { sinceDays = 7, limit = 8 } = {}) {
  const days = Number(sinceDays) || 7;
  const cur = db.prepare(`
    SELECT bc.category, COUNT(*) AS n
    FROM bookmark_categories bc
    JOIN bookmarks b ON b.id = bc.bookmark_id
    WHERE b.created_at >= datetime('now', ?)
    GROUP BY bc.category
  `).all(`-${days} days`);
  const prev = db.prepare(`
    SELECT bc.category, COUNT(*) AS n
    FROM bookmark_categories bc
    JOIN bookmarks b ON b.id = bc.bookmark_id
    WHERE b.created_at < datetime('now', ?)
      AND b.created_at >= datetime('now', ?)
    GROUP BY bc.category
  `).all(`-${days} days`, `-${days * 2} days`);
  const map = new Map();
  for (const r of cur) map.set(r.category, { current: r.n, previous: 0 });
  for (const r of prev) {
    const cur = map.get(r.category) || { current: 0, previous: 0 };
    cur.previous = r.n;
    map.set(r.category, cur);
  }
  const rows = [...map.entries()].map(([category, v]) => ({
    category,
    current: v.current,
    previous: v.previous,
    delta: v.current - v.previous,
  }));
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.current - a.current);
  return rows.slice(0, Number(limit) || 8);
}

/** Daily save and access counts (per day, local time) in the window. */
export function trendsTimeline(db, { sinceDays = 30 } = {}) {
  const days = Number(sinceDays) || 30;
  const saves = db.prepare(`
    SELECT date(created_at, 'localtime') AS d, COUNT(*) AS n
    FROM bookmarks
    WHERE created_at >= datetime('now', ?)
    GROUP BY d ORDER BY d ASC
  `).all(`-${days} days`);
  const accesses = db.prepare(`
    SELECT date(accessed_at, 'localtime') AS d, COUNT(*) AS n
    FROM accesses
    WHERE accessed_at >= datetime('now', ?)
    GROUP BY d ORDER BY d ASC
  `).all(`-${days} days`);
  // Build per-day series including zero-fill.
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({
      date: local,
      saves: saves.find(r => r.d === local)?.n ?? 0,
      accesses: accesses.find(r => r.d === local)?.n ?? 0,
    });
  }
  return out;
}

/** Top accessed domains in window. Joins accesses with bookmarks to get URLs. */
export function trendsDomains(db, { sinceDays = 30, limit = 12 } = {}) {
  const rows = db.prepare(`
    SELECT b.url, COUNT(a.id) AS hits
    FROM accesses a
    JOIN bookmarks b ON b.id = a.bookmark_id
    WHERE a.accessed_at >= datetime('now', ?)
    GROUP BY b.id
  `).all(`-${Number(sinceDays) || 30} days`);
  const tally = new Map();
  for (const r of rows) {
    const d = extractDomain(r.url);
    if (!d) continue;
    tally.set(d, (tally.get(d) ?? 0) + r.hits);
  }
  return [...tally.entries()]
    .map(([domain, hits]) => ({ domain, hits }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, Number(limit) || 12);
}

/**
 * Per-day estimated work minutes — sourced from `diary_entries.work_minutes`,
 * which is filled by Sonnet (`diary_work` task) when reading the day's URL
 * timeline. The previous algorithm derived sessions from visit_events alone
 * and over-counted days with long idle browser tabs (one open tab refreshing
 * itself for hours could push a single day past 24h).
 *
 * Days without a generated diary (or where Sonnet declined to estimate)
 * report `null` minutes — the chart skips them rather than misleading with 0.
 */
export function trendsWorkHours(db, { sinceDays = 30 } = {}) {
  const days = Number(sinceDays) || 30;
  function dateKeyLocal(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const rows = db.prepare(`
    SELECT date, work_minutes FROM diary_entries
    WHERE date >= ? AND work_minutes IS NOT NULL
  `).all(dateKeyLocal(new Date(Date.now() - (days - 1) * 86400_000)));
  const perDay = new Map();
  for (const r of rows) perDay.set(r.date, r.work_minutes);

  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const k = dateKeyLocal(dt);
    out.push({
      date: k,
      minutes: perDay.has(k) ? perDay.get(k) : null,
    });
  }
  return out;
}

/**
 * Per-day walking summary derived from `gps_locations` (OwnTracks 由来):
 *   - distance_km: 連続点の haversine 合計 (accuracy < 200m / Δt < 10min で
 *     ノイズフィルタ)
 *   - walking_minutes: 0.5〜3.5 m/s の区間 Δt 合計 (徒歩速度帯)
 *   - travel_minutes: 0.5 m/s 以上で動いていた区間 Δt 合計 (移動全体、
 *     乗り物含む)
 *
 * 静止判定は速度ベース。停車中の jitter は accuracy で弾く。
 */
export function trendsGpsWalking(db, { sinceDays = 30, userId = 'me' } = {}) {
  const days = Number(sinceDays) || 30;
  function dateKeyLocal(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function parseUtc(s) {
    return new Date(String(s).replace(' ', 'T') + 'Z');
  }
  function haversineMeters(a, b) {
    const R = 6_371_008;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const sa = Math.sin(dLat / 2);
    const so = Math.sin(dLon / 2);
    const h = sa * sa + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * so * so;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  const SEG_DT_MAX_MS = 10 * 60_000;       // > 10 分の隙間は信頼しない
  const ACC_MAX_M = 200;                   // accuracy 200m 超は jitter とみなす
  const WALK_MIN_MPS = 0.5;                // 1.8 km/h
  const WALK_MAX_MPS = 3.5;                // 12.6 km/h (上限 = ジョギング以下)
  const TRAVEL_MIN_MPS = 0.5;              // 動いている扱いの下限

  const startDate = new Date(Date.now() - (days - 1) * 86400_000);
  const startKey = dateKeyLocal(startDate);
  const rows = db.prepare(`
    SELECT recorded_at, lat, lon, accuracy_m
    FROM gps_locations
    WHERE user_id = ? AND date(recorded_at, 'localtime') >= ?
    ORDER BY recorded_at ASC
  `).all(userId, startKey);

  const perDay = new Map();
  function bucket(key) {
    let b = perDay.get(key);
    if (!b) {
      b = { distance_m: 0, walking_ms: 0, travel_ms: 0 };
      perDay.set(key, b);
    }
    return b;
  }
  let prev = null;
  for (const r of rows) {
    const d = parseUtc(r.recorded_at);
    const ts = d.getTime();
    if (!Number.isFinite(ts)) { prev = null; continue; }
    const key = dateKeyLocal(d);
    const accOk = !r.accuracy_m || r.accuracy_m < ACC_MAX_M;
    if (prev && prev.key === key && accOk && prev.accOk) {
      const dt = ts - prev.ts;
      if (dt > 0 && dt <= SEG_DT_MAX_MS) {
        const dist = haversineMeters(prev, { lat: r.lat, lon: r.lon });
        const speed = dist / (dt / 1000); // m/s
        const b = bucket(key);
        b.distance_m += dist;
        if (speed >= TRAVEL_MIN_MPS) b.travel_ms += dt;
        if (speed >= WALK_MIN_MPS && speed <= WALK_MAX_MPS) b.walking_ms += dt;
      }
    }
    prev = { ts, key, lat: r.lat, lon: r.lon, accOk };
  }

  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const k = dateKeyLocal(dt);
    const b = perDay.get(k);
    out.push({
      date: k,
      distance_km: b ? Number((b.distance_m / 1000).toFixed(2)) : 0,
      walking_minutes: b ? Math.round(b.walking_ms / 60_000) : 0,
      travel_minutes: b ? Math.round(b.travel_ms / 60_000) : 0,
    });
  }
  return out;
}

const KEYWORD_STOPWORDS = new Set([
  'the','and','for','with','from','that','this','your','you','our','have','has','was','were','will','what','when','where','which','who','about','into','than','then','also','but','not','are','can','use','using','how','why','etc',
  'について','として','による','によって','などの','する','して','です','ます','ない','ある','こと','もの','よう','これ','それ','ため','など','とは','では','での','さん','さま','様','記事','ページ','こちら','そして','しかし','ただし','ここ','以下','以上',
]);

function tokenize(text) {
  const t = String(text || '').toLowerCase();
  const out = [];
  // ASCII / Latin words ≥ 3 chars.
  for (const m of t.matchAll(/[a-z][a-z0-9_+#.-]{2,}/g)) out.push(m[0]);
  // Japanese-ish runs ≥ 2 chars (CJK + katakana/hiragana lump).
  for (const m of t.matchAll(/[぀-ヿ一-鿿]{2,}/g)) out.push(m[0]);
  return out.filter(w => !KEYWORD_STOPWORDS.has(w));
}

/**
 * Keyword frequency across recent page titles + bookmark titles + dig
 * queries. Crude tokeniser: ASCII words ≥3 chars + JP runs ≥2 chars,
 * minus stopwords.
 */
export function trendsKeywords(db, { sinceDays = 30, limit = 25 } = {}) {
  const days = Number(sinceDays) || 30;
  const ago = `-${days} days`;
  const sources = [];
  for (const r of db.prepare(`
    SELECT title FROM page_visits WHERE last_seen_at >= datetime('now', ?)
  `).all(ago)) sources.push(r.title);
  for (const r of db.prepare(`
    SELECT title FROM bookmarks WHERE created_at >= datetime('now', ?)
  `).all(ago)) sources.push(r.title);
  for (const r of db.prepare(`
    SELECT query FROM dig_sessions WHERE created_at >= datetime('now', ?)
  `).all(ago)) sources.push(r.query);
  // Dictionary terms also reflect what the user is studying.
  for (const r of db.prepare(`
    SELECT term FROM dictionary_entries WHERE updated_at >= datetime('now', ?)
  `).all(ago)) sources.push(r.term);

  const tally = new Map();
  for (const text of sources) {
    if (!text) continue;
    const seen = new Set();  // count each source once per word
    for (const w of tokenize(text)) {
      if (seen.has(w)) continue;
      seen.add(w);
      tally.set(w, (tally.get(w) || 0) + 1);
    }
  }
  return [...tally.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Number(limit) || 25);
}
