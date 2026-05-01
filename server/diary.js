// Diary — aggregate a day of browser visit events (and optionally GitHub
// commits) and ask claude to write a daily report.
//
// Hourly buckets, top domains, and active hours are computed locally;
// claude is asked only to narrate.

import { visitEventsForDate, getDiary, getDomainCatalogMap, digSessionsForDate, listServerEventsForDate, listGpsLocationsForDate, listMealsForDate } from './db.js';
import { runLlm } from './llm.js';

// Downtimes >5 min make it into the diary; shorter gaps are treated as
// restarts (e.g. process kill + npm start) and silently ignored.
const DIARY_DOWNTIME_THRESHOLD_MS = 5 * 60 * 1000;

// Default models per task are configured in llm.js (sonnet for diary_work,
// opus 1M for diary_highlights / diary_weekly). The user can override per task
// from the AI settings panel.

const MIN_VISITS_FOR_REPORT = 1;

function extractDomain(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
}

// SQLite stores datetime() values as UTC strings without a timezone marker
// ("2026-04-27 02:00:00"). new Date() on that string parses it as local
// time — wrong by the local TZ offset. Append `Z` so JS parses it as UTC,
// then standard accessors (getHours(), toLocaleString(), etc.) return the
// correct LOCAL values.
function parseSqliteUtc(s) {
  if (!s) return null;
  const iso = String(s).replace(' ', 'T');
  // Already has TZ info — leave it alone.
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) return new Date(iso);
  return new Date(iso + 'Z');
}

/**
 * Aggregate the day from BOTH sources together (no URL-level dedup).
 * - visit_events: per-event log. 1 row = 1 hit at its precise hour.
 * - page_visits:  per-URL row touched today. 1 row = 1 hit at last_seen_at's hour.
 * Overlap between the two sources is intentional — when a URL appears in both,
 * that signals "heavy activity on that URL" (touched many times today, plus
 * still present in the per-URL touch table).
 */
// Initial page size for the bookmark / dig lists in the diary view.
// Anything beyond this is loaded on-demand via the per-list endpoints.
const DIARY_LIST_INITIAL = 10;

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
    sources: {
      visit_events: events.length,
      page_visits: pageVisitsContribution,
    },
  };
}

function parseMealAdditions(json) {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Haversine 距離 (m)。地球半径 6371008 m (mean)。短距離では誤差は数 cm 以下。
function haversineMeters(a, b) {
  const R = 6_371_008;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sa = Math.sin(dLat / 2);
  const so = Math.sin(dLon / 2);
  const h = sa * sa + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * so * so;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 当日の GPS 点列から日記用 metrics を組み立てる。
 *
 * 出力:
 *   { points, devices, distance_meters, bbox, midpoint, hours, first_at, last_at }
 *
 * `bbox` / `midpoint` は Opus 1M プロンプトで「どのあたりに居たか」を
 * narrate させるのに最低限必要な情報。`midpoint` は `bbox` の中心。
 *
 * 静止判定 (e.g., 同一地点で 30 分滞留 = 「滞在」) は誤判定リスクが高いので
 * 当面は実装しない。アクティブ時間帯 (`hours`) のみ使う。
 *
 * 距離は連続する 2 点間 haversine の和。jitter 込みなので「歩いた距離」より
 * やや大きめになるが、概算用途なら十分。
 */
export function summarizeGpsForDate(points) {
  if (!points || points.length === 0) {
    return {
      points: 0,
      devices: [],
      distance_meters: 0,
      bbox: null,
      midpoint: null,
      hours: [],
      first_at: null,
      last_at: null,
    };
  }
  const devices = new Set();
  const hourSet = new Set();
  let minLat = +Infinity, maxLat = -Infinity;
  let minLon = +Infinity, maxLon = -Infinity;
  let dist = 0;
  let prev = null;
  for (const p of points) {
    if (p.device_id) devices.add(p.device_id);
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    const h = parseSqliteUtc(p.recorded_at)?.getHours();
    if (Number.isFinite(h)) hourSet.add(h);
    if (prev) {
      // Skip outliers: accuracy なし or > 200m の点は連続性を信頼しない
      const accOk = !p.accuracy_m || p.accuracy_m < 200;
      if (accOk) dist += haversineMeters(prev, p);
    }
    prev = p;
  }
  return {
    points: points.length,
    devices: [...devices],
    distance_meters: Math.round(dist),
    bbox: {
      lat: [Number(minLat.toFixed(5)), Number(maxLat.toFixed(5))],
      lon: [Number(minLon.toFixed(5)), Number(maxLon.toFixed(5))],
    },
    midpoint: {
      lat: Number(((minLat + maxLat) / 2).toFixed(5)),
      lon: Number(((minLon + maxLon) / 2).toFixed(5)),
    },
    hours: [...hourSet].sort((a, b) => a - b),
    first_at: points[0].recorded_at ?? null,
    last_at: points[points.length - 1].recorded_at ?? null,
  };
}

/**
 * Fetch a user's commits authored on `dateStr`.
 * - If `repos` is supplied: per-repo commits API (works for public repos
 *   without auth; needs PAT for private).
 * - Otherwise: GitHub search/commits across all of GitHub (PAT required).
 *
 * The events API was avoided because /users/{user}/events does not include
 * commit lists in its payload (only ref/head/before SHAs).
 */
export async function fetchGithubActivity({ token, user, repos, dateStr, timeoutMs = 30_000 }) {
  if (!user) return null;

  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Memoria-diary/0.1',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const since = `${dateStr}T00:00:00Z`;
  const until = `${dateStr}T23:59:59Z`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const commits = [];
  const errors = [];

  try {
    if (repos && repos.length > 0) {
      for (const repo of repos) {
        const url = `https://api.github.com/repos/${repo}/commits`
          + `?author=${encodeURIComponent(user)}`
          + `&since=${encodeURIComponent(since)}`
          + `&until=${encodeURIComponent(until)}`
          + `&per_page=100`;
        const res = await fetch(url, { headers, signal: ac.signal });
        if (!res.ok) {
          errors.push(`${repo}: ${res.status} ${res.statusText}`);
          continue;
        }
        const arr = await res.json();
        for (const c of arr) {
          commits.push(formatCommit({ ...c, _repo: repo }));
        }
      }
    } else {
      // Search across all repos the user can reach. Needs auth.
      const q = `author:${user} author-date:${dateStr}`;
      const url = `https://api.github.com/search/commits?q=${encodeURIComponent(q)}&per_page=100`;
      const res = await fetch(url, { headers, signal: ac.signal });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        return { error: `github API ${res.status}: ${body}` };
      }
      const data = await res.json();
      for (const c of (data.items || [])) {
        commits.push(formatCommit({ ...c, _repo: c.repository?.full_name }));
      }
    }
    return {
      commits,
      errors: errors.length ? errors : undefined,
      fetched_at: new Date().toISOString(),
    };
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

function formatCommit(c) {
  const fullMsg = c.commit?.message || '';
  return {
    repo: c._repo || c.repository?.full_name || '',
    sha: (c.sha || '').slice(0, 7),
    message: fullMsg.split('\n')[0].slice(0, 200),
    author: c.commit?.author?.name || c.author?.login || '',
    created_at: c.commit?.author?.date || c.commit?.committer?.date || '',
    url: c.html_url || '',
  };
}

/**
 * Probe a few GitHub endpoints to figure out *why* a PAT is failing — a single
 * /user call can return 401 simply because a fine-grained PAT lacks Account
 * permissions, even though the token itself is valid.
 */
export async function pingGithub({ token, user, timeoutMs = 12_000 }) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Memoria-diary/0.1',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  const fmt = {
    classic: !!(token && /^gh[pousr]_/.test(token)),
    fine_grained: !!(token && /^github_pat_/.test(token)),
    length: token ? token.length : 0,
  };

  const probes = [];
  async function tryProbe(name, url) {
    try {
      const res = await fetch(url, { headers, signal: ac.signal });
      let body = '';
      if (!res.ok) body = (await res.text()).slice(0, 200);
      probes.push({ name, url, status: res.status, ok: res.ok, body });
      return res;
    } catch (e) {
      probes.push({ name, url, error: e.message });
      return null;
    }
  }

  try {
    const userRes = await tryProbe('user', 'https://api.github.com/user');
    await tryProbe('rate_limit', 'https://api.github.com/rate_limit');
    if (user) {
      await tryProbe('user_public', `https://api.github.com/users/${encodeURIComponent(user)}`);
    }

    if (userRes?.ok) {
      const data = await userRes.json();
      return {
        ok: true,
        login: data.login,
        scopes: userRes.headers.get('x-oauth-scopes') || '',
        token_format: fmt,
        probes,
      };
    }

    // Build a diagnostic hint based on what failed.
    const hint = inferAuthHint({ probes, fmt });
    return { ok: false, status: userRes?.status, hint, token_format: fmt, probes };
  } catch (e) {
    return { ok: false, error: e.message, token_format: fmt, probes };
  } finally {
    clearTimeout(timer);
  }
}

function inferAuthHint({ probes, fmt }) {
  const userProbe = probes.find(p => p.name === 'user');
  const rate = probes.find(p => p.name === 'rate_limit');
  const userPub = probes.find(p => p.name === 'user_public');

  // /users/<u> works WITHOUT auth normally, so a 401 there means the Bearer
  // header itself was rejected — i.e. the token is unknown to GitHub.
  if (userPub?.status === 401) {
    return 'トークン自体が GitHub に存在しません (revoke 済み・期限切れ・別アカウント発行・コピー切れのいずれか)。GitHub Settings → Developer settings → Personal access tokens を開き、保存されているトークン (先頭は github_pat_) が一覧にあり active か確認してください。なければ作り直しが必要です。';
  }
  if (rate?.ok && userProbe?.status === 401 && fmt.fine_grained) {
    return 'トークンは生きていますが /user で拒否。fine-grained PAT は発行時に Account permissions → "Profile (Read)" を有効化しないと /user 系が通りません。';
  }
  if (userProbe?.status === 401 && fmt.classic) {
    return 'classic PAT が拒否されました。期限切れ・revoke・スコープ不足の可能性。`repo` と `read:user` を含めて作り直してください。';
  }
  if (userProbe?.status === 401 && !fmt.classic && !fmt.fine_grained) {
    return 'PAT のフォーマットが GitHub の標準形式 (`ghp_...` か `github_pat_...`) と一致しません。トークンを再確認してください。';
  }
  return 'GitHub から 401 が返りました。期限切れ・revoke・権限不足のいずれかです。';
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

/** GitHub commits grouped by repository: { byRepo: {repo: count}, total, repos: [...] }. */
export function summarizeGithubByRepo(github) {
  const commits = github?.commits || [];
  const byRepo = new Map();
  for (const c of commits) {
    const r = c.repo || '(unknown)';
    if (!byRepo.has(r)) byRepo.set(r, { count: 0, samples: [] });
    const cur = byRepo.get(r);
    cur.count += 1;
    if (cur.samples.length < 3) cur.samples.push({ sha: c.sha, message: c.message });
  }
  const repos = [...byRepo.entries()]
    .map(([repo, v]) => ({ repo, count: v.count, samples: v.samples }))
    .sort((a, b) => b.count - a.count);
  return { repos, total: commits.length };
}

const WORK_CONTENT_PROMPT = ({ dateStr, urlList, totalEvents, totalDomains }) => [
  `あなたは ${dateStr} の「作業内容」セクションを書きます。`,
  'ブラウザ閲覧履歴 (URL + 時刻) を読み、**大まかな時間帯**で何をしていたかを 1 文でまとめ、',
  'その下に主な作業を箇条書きで添えてください。細かい行動を全部書く必要はありません。',
  '',
  '出力フォーマット (markdown のみ。前置き・コードフェンス禁止):',
  '',
  '```',
  'HH:MM～HH:MM： <その時間帯に何をしていたかを 1 文>',
  '主な作業',
  '・<具体的な内容> (HH:MM頃)',
  '・<具体的な内容> (HH:MM頃)',
  '・<具体的な内容>',
  '',
  'HH:MM～HH:MM： 記録なし',
  '',
  'HH:MM～HH:MM： <次の時間帯>',
  '主な作業',
  '・<具体的な内容> (HH:MM頃)',
  '',
  'WORK_MINUTES: <整数>',
  '```',
  '',
  '時間帯のルール:',
  '- 1 ブロック = 2〜4 時間が目安。細かく刻みすぎない。',
  '- 活動が連続する時間帯はまとめる。間が 30 分以上空いたら別ブロック。',
  '- ログのない時間帯 (寝てる / PC 離れてた等と推察できる範囲) は「記録なし」と書く',
  '- 開始は最初のアクセス時刻、終了は次の活動開始 or 最終アクセス',
  '',
  '内容のルール:',
  '- 1 文目はその時間帯のテーマ (例: 「Memoria の UI 改修をしていた」)',
  '- 「主な作業」は 2〜5 個、重要度の高い順',
  '- 推測でも断定口調 (◯◯を確認)。「〜していたと推測」「〜と思われる」は不要',
  '- ドメイン名や URL を直接出さず、内容で書く',
  '- 同じ時間帯で複数テーマがあれば 1 ブロックにまとめて 1 文で言及してから箇条書き',
  '',
  '## 作業時間の見積もり (最終行に必ず WORK_MINUTES を出す)',
  '本文の最後に空行 1 つを挟んで `WORK_MINUTES: <整数>` を必ず付けてください。',
  '- 単位は「分」。整数 (例: 360)。',
  '- 各時間帯の本文を見て「実際に集中して作業していた時間」を合計してください。',
  '  単純な開始〜終了の wall clock ではなく、移動・休憩・離席・SNS 流し見等は除く。',
  '- ブラウザのタブが開きっぱなしでもアクセス記録に動きがない時間は作業していないとみなす。',
  '- 「記録なし」のブロックは 0 分。',
  '- 24 時間 (1440 分) を超えてはいけない。実態として 12 時間を超えるのは長時間集中日のみ。',
  '- 推定材料が足りない (例: 1 件しかアクセスがない) 場合は WORK_MINUTES: 0 と書く。',
  '',
  `日付: ${dateStr}`,
  `総アクセス: ${totalEvents}`,
  `ユニークドメイン: ${totalDomains}`,
  '',
  'URL 履歴 (時刻 + URL):',
  urlList,
].join('\n');

/**
 * Pull `WORK_MINUTES: <int>` off the tail of the Sonnet output and return both
 * the cleaned narrative and the parsed minutes. Sonnet is asked to put this
 * line at the very end with a blank line before it; we tolerate any trailing
 * whitespace and missing blank line. Anything outside [0, 1440] is dropped.
 */
export function extractWorkMinutes(raw) {
  if (!raw) return { content: '', workMinutes: null };
  const text = String(raw);
  // Match the last WORK_MINUTES line (case-insensitive, allow whitespace).
  const re = /^[ \t]*WORK[_ ]MINUTES[ \t]*[:：][ \t]*(\d{1,5})[ \t]*$/im;
  const matches = [...text.matchAll(new RegExp(re.source, 'gim'))];
  if (matches.length === 0) {
    return { content: text.trim(), workMinutes: null };
  }
  const last = matches[matches.length - 1];
  const minutes = Number(last[1]);
  const cleaned = text.slice(0, last.index).replace(/\s+$/, '').trim();
  // Reject implausible values rather than persisting nonsense.
  const valid = Number.isFinite(minutes) && minutes >= 0 && minutes <= 24 * 60;
  return { content: cleaned, workMinutes: valid ? minutes : null };
}

function formatGpsBlock(metrics) {
  const g = metrics?.gps;
  if (!g || !g.points) return '(GPS 記録なし)';
  const km = (g.distance_meters / 1000).toFixed(2);
  const hourSpan = g.hours?.length
    ? `${g.hours[0]}:00〜${g.hours[g.hours.length - 1]}:00 のあいだ`
    : '';
  const bbox = g.bbox
    ? `緯度 ${g.bbox.lat[0]}〜${g.bbox.lat[1]} / 経度 ${g.bbox.lon[0]}〜${g.bbox.lon[1]}`
    : '';
  const center = g.midpoint
    ? `中心付近 (${g.midpoint.lat}, ${g.midpoint.lon})`
    : '';
  const lines = [
    `- 記録点数: ${g.points} 点 (デバイス: ${g.devices.join(', ') || '不明'})`,
    `- 概算移動距離: 約 ${km} km`,
  ];
  if (hourSpan) lines.push(`- アクティブ時間帯: ${hourSpan}`);
  if (bbox)     lines.push(`- 範囲: ${bbox}`);
  if (center)   lines.push(`- ${center}`);
  return lines.join('\n');
}

function formatDowntimeBlock(metrics) {
  const dts = metrics?.downtimes || [];
  if (!dts.length) return '(なし)';
  return dts.map(d => {
    const from = (d.from || '').replace('T', ' ').slice(0, 19);
    const to = (d.to || '').replace('T', ' ').slice(0, 19);
    const mins = Math.round((d.duration_ms || 0) / 60_000);
    return `- ${from} 〜 ${to} (${mins} 分間 Memoria サーバ停止 → アクセスログ取得なし)`;
  }).join('\n');
}

function formatMealsBlock(metrics) {
  const meals = metrics?.meals || [];
  if (!meals.length) return '(食事の記録なし)';
  const lines = meals.map((m) => {
    const t = (m.eaten_at || '').replace('T', ' ').slice(11, 16);
    const desc = m.description || '(未記入)';
    const cal = (typeof m.total_calories === 'number') ? `${m.total_calories} kcal` : '— kcal';
    const loc = m.location_label ? ` @ ${m.location_label}` : '';
    const adds = (m.additions || [])
      .map((a) => {
        const ac = typeof a.calories === 'number' ? ` ${a.calories}kcal` : '';
        return `＋${a.name}${ac}`;
      })
      .join(', ');
    const addsLine = adds ? ` (追加: ${adds})` : '';
    return `- ${t} ${desc} — ${cal}${loc}${addsLine}`;
  });
  const total = (typeof metrics.meals_total_calories === 'number') ? metrics.meals_total_calories : null;
  if (total != null) lines.push(`総カロリー (推定): 約 ${total} kcal`);
  return lines.join('\n');
}

const HIGHLIGHTS_PROMPT = ({ dateStr, workContent, githubByRepo, bookmarkSummary, digs, notes, metrics }) => [
  `あなたは ${dateStr} の「ハイライト」セクションを書きます。`,
  '以下の情報を統合し、その日の重要なポイントを箇条書きで 3〜6 個。',
  '事実ベース。憶測や創作はしない。重要度の高い順。',
  '',
  '## 入力 1: 作業内容 (時系列)',
  workContent || '(なし)',
  '',
  '## 入力 2: 新規ブックマーク件数',
  `${bookmarkSummary.created} 件 (再訪 ${bookmarkSummary.accessed} 件)`,
  bookmarkSummary.topDomains
    ? `主なドメイン: ${bookmarkSummary.topDomains.join(', ')}`
    : '',
  '',
  '## 入力 3: GitHub commits (リポジトリごとの件数)',
  githubByRepo.repos.length
    ? githubByRepo.repos.map(r => `- ${r.repo}: ${r.count} commits`).join('\n')
    : '(なし)',
  '',
  '## 入力 4: 当日のディグ調査 (検索 + 取得した情報源)',
  (digs && digs.length > 0)
    ? digs.map(d => {
        const summary = d.summary ? `\n  ${d.summary.slice(0, 300)}` : '';
        return `- 「${d.query}」 (${d.source_count} 件のソース, ${d.status})${summary}`;
      }).join('\n')
    : '(なし)',
  '',
  '## メタ情報',
  `総アクセス: ${metrics.total_events} / アクティブ時間帯: ${metrics.active_hours.join(',')}`,
  '',
  '## 移動 (GPS 軌跡 — OwnTracks 由来、参考情報)',
  formatGpsBlock(metrics),
  '※ GPS は jitter があるため数値は概算。場所推定は座標から自然に解釈できる範囲のみ書くこと (推測しすぎない)。',
  '',
  '## サーバ停止 (5 分超のダウンタイム)',
  formatDowntimeBlock(metrics),
  '上記時間帯はアクセスログが欠落しているので、その時間帯の活動についてはデータがない旨を簡潔に注記してください。',
  '',
  '## 食事 (写真投稿 + AI 推定 / 手動補正、 参考情報)',
  formatMealsBlock(metrics),
  '※ カロリーは推定値で誤差を含む。 ハイライトに含める時は「総カロリー約 X kcal」 のような概数表記で。',
  '',
  notes ? `## ユーザのメモ・補足 (反映してください)\n${notes}\n` : '',
  '',
  '出力フォーマット (markdown のみ。前置き不要):',
  '- ハイライト1',
  '- ハイライト2',
].join('\n');

// Legacy single-prompt template — retained for fallback if a stage fails so we
// can still return some narrative.
const DIARY_PROMPT_TEMPLATE = ({ dateStr, metrics, github, notes }) => {
  const hourlyTable = metrics.hourly_visits
    .map((n, h) => `${String(h).padStart(2, '0')}:00 → ${n}`)
    .filter((_, h) => metrics.hourly_visits[h] > 0)
    .join(', ');
  const domainTable = metrics.top_domains
    .map(d => {
      const display = d.site_name ? `${d.site_name} (${d.domain})` : d.domain;
      const desc = d.description ? ` — ${d.description}` : '';
      return `${display} ${d.count}件 [時間帯 ${d.active_hours.join(',')}]${desc}`;
    })
    .join('\n');
  const githubBlock = github?.commits?.length
    ? github.commits.map(c => `- [${c.repo} ${c.sha}] ${c.message}`).join('\n')
    : github?.error
      ? `(GitHub 取得失敗: ${github.error})`
      : '(GitHub commit なし)';
  const created = metrics.bookmarks?.created || [];
  const accessed = metrics.bookmarks?.accessed || [];
  const totalBookmarks = created.length + accessed.length;
  // When bookmark count balloons, the prompt becomes too long and the per-item
  // detail dilutes the narrative — fall back to a domain-only summary.
  const BOOKMARK_DETAIL_THRESHOLD = 10;
  let bookmarkSection;
  if (totalBookmarks === 0) {
    bookmarkSection = '新規・再訪したブックマーク: (なし)';
  } else if (totalBookmarks > BOOKMARK_DETAIL_THRESHOLD) {
    const allDomains = new Map();
    for (const b of [...created, ...accessed]) {
      try {
        const dom = new URL(b.url).hostname.toLowerCase();
        allDomains.set(dom, (allDomains.get(dom) || 0) + (b.access_count || 1));
      } catch {}
    }
    const domLines = [...allDomains.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([d, n]) => `- ${d} (${n} 件)`)
      .join('\n');
    bookmarkSection = [
      `ブックマーク総数: 新規 ${created.length} 件 + 再訪 ${accessed.length} 件 = ${totalBookmarks} 件`,
      '(個別タイトルは省略。ドメイン分布から作業内容を推察してください)',
      domLines,
    ].join('\n');
  } else {
    const createdBlock = created.length
      ? created.map(b => `- ${b.title} (${b.url})${b.summary ? '\n  ' + b.summary.slice(0, 200) : ''}`).join('\n')
      : '(新規ブックマークなし)';
    const accessedBlock = accessed.length
      ? accessed.map(b => `- ${b.title} ×${b.access_count} (${b.url})`).join('\n')
      : '(再訪したブックマークなし)';
    bookmarkSection = `新規ブックマーク:\n${createdBlock}\n\n再訪したブックマーク:\n${accessedBlock}`;
  }
  const notesBlock = notes ? `\nUSER NOTES (反映してください):\n${notes}\n` : '';
  return [
    `あなたは ${dateStr} の活動データから 1 日の日報を書きます。`,
    '事実だけを淡々と。憶測や創作はせず、データから読み取れる活動のみを書きます。',
    '',
    '出力フォーマット (markdown):',
    '## 全体像',
    '一段落で「何時頃から何時頃まで何をしていた風」かをまとめる。',
    '## 時間帯別',
    '- HH:00 〜 HH:00: ドメインから推測される作業',
    '## ブックマーク',
    '- 新規追加・再訪したブックマークから読み取れる関心',
    '## ハイライト',
    '- GitHub commit、印象的な調査、ニュース等',
    '',
    `日付: ${dateStr}`,
    `総アクセス: ${metrics.total_events}`,
    `ユニークドメイン: ${metrics.unique_domains}`,
    `アクティブ時間帯: ${hourlyTable || '(なし)'}`,
    '',
    'TOP DOMAINS:',
    domainTable || '(なし)',
    '',
    bookmarkSection,
    '',
    'GITHUB COMMITS:',
    githubBlock,
    notesBlock,
  ].join('\n');
};

/**
 * Build the URL list for the work-content prompt. Format: "HH:MM <url>" per line,
 * deduped consecutively (collapse runs of the same URL within 2 minutes).
 */
function buildUrlList(db, dateStr) {
  const events = visitEventsForDate(db, dateStr);
  if (events.length === 0) {
    // Fall back to page_visits where last_seen is the date.
    const visits = db.prepare(`
      SELECT v.url, v.last_seen_at FROM page_visits v
      WHERE date(v.last_seen_at, 'localtime') = ?
      ORDER BY v.last_seen_at ASC
    `).all(dateStr);
    return visits.map(v => formatUrlLine(v.last_seen_at, v.url)).join('\n');
  }
  const lines = [];
  let lastUrl = '';
  let lastTs = 0;
  for (const e of events) {
    const ts = parseSqliteUtc(e.visited_at)?.getTime() || 0;
    if (e.url === lastUrl && Math.abs(ts - lastTs) < 120_000) continue; // collapse <2min
    lines.push(formatUrlLine(e.visited_at, e.url));
    lastUrl = e.url;
    lastTs = ts;
  }
  // Cap to a sane upper bound to avoid stalling Sonnet.
  return lines.slice(-800).join('\n');
}

function formatUrlLine(ts, url) {
  // ts is a SQLite UTC datetime ('YYYY-MM-DD HH:MM:SS'). Parse as UTC then
  // emit the local HH:MM so claude sees the user's wall-clock time, not
  // UTC offset by the local timezone.
  const d = parseSqliteUtc(ts);
  if (!d || isNaN(d.getTime())) return `??:?? ${url}`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm} ${url}`;
}

function appendMemoAndImprove(prompt, { globalMemo, improve } = {}) {
  const tail = [];
  if (globalMemo && globalMemo.trim()) {
    tail.push('', '## ユーザの常設メモ (毎回参照)', globalMemo.trim());
  }
  if (improve && improve.trim()) {
    tail.push('', '## このターンだけの改善指示 (最優先)', improve.trim());
  }
  return tail.length > 0 ? `${prompt}\n${tail.join('\n')}` : prompt;
}

/**
 * Stage 1: Sonnet (default) writes 作業内容 from the URL timeline AND infers
 * the day's focused work minutes (tail line `WORK_MINUTES: <int>`). Returns
 * `{ content, workMinutes }` — content is the markdown shown to the user
 * (tail stripped), workMinutes feeds the trends chart.
 */
export async function generateWorkContent({ db, dateStr, metrics, globalMemo, improve, timeoutMs = 180_000 }) {
  const urlList = buildUrlList(db, dateStr);
  if (!urlList.trim()) return { content: '', workMinutes: null };
  const base = WORK_CONTENT_PROMPT({
    dateStr,
    urlList,
    totalEvents: metrics.total_events,
    totalDomains: metrics.unique_domains,
  });
  const prompt = appendMemoAndImprove(base, { globalMemo, improve });
  const raw = await runLlm({ task: 'diary_work', prompt, timeoutMs });
  return extractWorkMinutes(raw);
}

/** Stage 3: Opus 1M (default) integrates work content + bookmark count + commits + dig into highlights. */
export async function generateHighlights({ dateStr, workContent, githubByRepo, bookmarkSummary, digs, notes, metrics, globalMemo, improve, timeoutMs = 240_000 }) {
  const base = HIGHLIGHTS_PROMPT({
    dateStr, workContent, githubByRepo, bookmarkSummary, digs, notes, metrics,
  });
  const prompt = appendMemoAndImprove(base, { globalMemo, improve });
  return await runLlm({ task: 'diary_highlights', prompt, timeoutMs });
}

/**
 * Top-level diary generator orchestrating the three stages. Returns the
 * structured pieces; the caller persists them.
 */
export async function generateDiary({ db, dateStr, metrics, github, notes }) {
  const githubByRepo = summarizeGithubByRepo(github);
  const bookmarkSummary = buildBookmarkSummary(metrics);

  // Edge case: nothing happened at all.
  if (metrics.total_events < MIN_VISITS_FOR_REPORT
      && !github?.commits?.length && !notes
      && bookmarkSummary.created === 0 && bookmarkSummary.accessed === 0) {
    return {
      workContent: '',
      githubByRepo,
      highlights: '',
      summary: '本日の活動記録は取得できていません。',
    };
  }

  const { content: workContent, workMinutes } = await generateWorkContent({ db, dateStr, metrics });
  const digs = metrics.digs || [];
  const highlights = await generateHighlights({
    dateStr, workContent, githubByRepo, bookmarkSummary, digs, notes, metrics,
  });

  // Combined summary for legacy display.
  const summary = composeSummary({ workContent, githubByRepo, highlights, digs });
  return { workContent, workMinutes, githubByRepo, highlights, summary, digs };
}

function buildBookmarkSummary(metrics) {
  const created = metrics.bookmarks?.created || [];
  const accessed = metrics.bookmarks?.accessed || [];
  const domSet = new Set();
  for (const b of [...created, ...accessed]) {
    try { domSet.add(new URL(b.url).hostname); } catch {}
  }
  return {
    created: created.length,
    accessed: accessed.length,
    topDomains: [...domSet].slice(0, 8),
  };
}

function composeSummary({ workContent, githubByRepo, highlights, digs }) {
  const parts = [];
  if (workContent) parts.push(`## 作業内容\n${workContent.trim()}`);
  if (digs && digs.length > 0) {
    const digLines = digs.map(d => {
      const head = `- 「${d.query}」 (${d.source_count} 件のソース)`;
      return d.summary ? `${head}\n  ${d.summary.slice(0, 250)}` : head;
    }).join('\n');
    parts.push(`## ディグ調査\n${digLines}`);
  }
  if (githubByRepo.repos.length) {
    const repoLines = githubByRepo.repos
      .map(r => `- ${r.repo}: ${r.count} commits`)
      .join('\n');
    parts.push(`## GitHub commits (${githubByRepo.total} 件)\n${repoLines}`);
  }
  if (highlights) parts.push(`## ハイライト\n${highlights.trim()}`);
  return parts.join('\n\n');
}

// ── weekly --------------------------------------------------------------

const WEEKLY_PROMPT = ({ weekStart, weekEnd, dailyBlock, githubBlock }) => [
  `あなたは ${weekStart} から ${weekEnd} までの「週報」を書きます。`,
  '7 日分の日報と GitHub コミットヒストリから、週全体での実作業を統合してください。',
  '',
  '出力フォーマット (markdown のみ。前置き不要):',
  '## 今週やったこと',
  '一段落で週全体を概観。',
  '## 主な成果',
  '- 箇条書き。GitHub commit から実装した機能・修正を中心に。',
  '- 進捗が大きかったプロジェクトを優先。',
  '## トピック別',
  '- 学んだこと・調べたこと (作業内容ベース)',
  '## 来週への引き継ぎ',
  '- 未完了に見える作業やフォローアップ',
  '',
  '出力ルール:',
  '- 創作禁止。日報と commit に基づくこと',
  '- リポジトリ名は短く (org/ は省いて末尾のみで OK)',
  '',
  '## 入力 1: 日報サマリ (日付ごと)',
  dailyBlock,
  '',
  '## 入力 2: GitHub commit ヒストリ',
  githubBlock,
].join('\n');

/**
 * Generate a weekly narrative from 7 daily diaries + commits.
 * The caller pre-fetches both via the GitHub API (per-repo commits API).
 */
export async function generateWeekly({ weekStart, weekEnd, dailyDiaries, githubByRepo, timeoutMs = 360_000 }) {
  const dailyBlock = dailyDiaries.map(d => {
    const head = d.summary || d.work_content || '(日報なし)';
    return `### ${d.date}\n${(head || '').slice(0, 1500)}`;
  }).join('\n\n');
  const githubBlock = githubByRepo.repos.length
    ? githubByRepo.repos.map(r => {
      const samples = (r.samples || []).map(s => `  - ${s.sha} ${s.message}`).join('\n');
      return `${r.repo}: ${r.count} commits\n${samples}`;
    }).join('\n\n')
    : '(commit なし)';
  const prompt = WEEKLY_PROMPT({ weekStart, weekEnd, dailyBlock, githubBlock });
  return await runLlm({ task: 'diary_weekly', prompt, timeoutMs });
}

/** Fetch a user's commits across `repos` in a date range, grouped by repo. */
export async function fetchGithubRange({ token, user, repos, since, until, timeoutMs = 30_000 }) {
  if (!user || !repos?.length) return { commits: [], repos: [] };
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Memoria-diary/0.1',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const all = [];
  try {
    for (const repo of repos) {
      const url = `https://api.github.com/repos/${repo}/commits`
        + `?author=${encodeURIComponent(user)}`
        + `&since=${encodeURIComponent(since)}`
        + `&until=${encodeURIComponent(until)}`
        + `&per_page=100`;
      const res = await fetch(url, { headers, signal: ac.signal });
      if (!res.ok) continue;
      const arr = await res.json();
      for (const c of arr) all.push(formatCommit({ ...c, _repo: repo }));
    }
    return { commits: all, ...summarizeGithubByRepo({ commits: all }) };
  } finally {
    clearTimeout(timer);
  }
}

/** YYYY-MM-DD in local time for a given Date instance (or now). */
export function formatLocalDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Date string for "yesterday" relative to the supplied moment. */
export function yesterdayLocal(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return formatLocalDate(d);
}

/** Monday → Sunday inclusive range that contains `dateStr`. */
export function weekRangeFor(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  // Mon=1,...,Sun=7 (ISO). JS getDay: Sun=0,Mon=1,...
  const dow = d.getDay();
  const offsetToMonday = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(d);
  mon.setDate(d.getDate() + offsetToMonday);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { start: formatLocalDate(mon), end: formatLocalDate(sun) };
}

/** Which week-of-month does `weekStart` fall in (1-based, by Mon). */
export function weekOfMonth(weekStart) {
  const d = new Date(weekStart + 'T00:00:00');
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  // Find first Monday in the month containing weekStart's Monday.
  const firstDay = new Date(d.getFullYear(), d.getMonth(), 1);
  const dow = firstDay.getDay();
  const firstMon = new Date(firstDay);
  firstMon.setDate(1 + ((dow === 0 ? 1 : (8 - dow) % 7)));
  const diffDays = Math.round((d - firstMon) / 86400000);
  const idx = Math.floor(diffDays / 7) + 1;
  return { month, weekInMonth: idx };
}
