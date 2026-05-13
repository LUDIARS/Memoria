// Diary — aggregate a day of browser visit events (and optionally GitHub
// commits) and ask claude to write a daily report.
//
// Hourly buckets, top domains, and active hours are computed locally;
// claude is asked only to narrate.

import type BetterSqlite3 from 'better-sqlite3';
import {
  visitEventsForDate, getDomainCatalogMap, digSessionsForDate,
  listServerEventsForDate, listGpsLocationsForDate, listMealsForDate,
  getAppSettings, activityEventsForDate,
  appUsageForDate, gameUsageForDate,
} from './db.js';
import type { AppUsageRow, GameUsageRow } from './db.js';
import { runLlm } from './llm.js';
import type { VisitEventRow } from './db/types/visit.js';
import type { ActivityKind } from './db/types/activity.js';
import type { DomainCatalogRow } from './db/types/page.js';
import type { GpsLocationRow } from './db/types/gps.js';
import type { MealRow } from './db/types/meal.js';
import type { DigSessionRow } from './db/types/dig.js';

type Db = BetterSqlite3.Database;

// Downtimes >5 min make it into the diary; shorter gaps are treated as
// restarts (e.g. process kill + npm start) and silently ignored.
const DIARY_DOWNTIME_THRESHOLD_MS = 5 * 60 * 1000;

// Default models per task are configured in llm.js (sonnet for diary_work,
// opus 1M for diary_highlights / diary_weekly). The user can override per task
// from the AI settings panel.

const MIN_VISITS_FOR_REPORT = 1;

function extractDomain(url: string | null | undefined): string | null {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
}

// SQLite stores datetime() values as UTC strings without a timezone marker
// ("2026-04-27 02:00:00"). new Date() on that string parses it as local
// time — wrong by the local TZ offset. Append `Z` so JS parses it as UTC,
// then standard accessors (getHours(), toLocaleString(), etc.) return the
// correct LOCAL values.
function parseSqliteUtc(s: string | null | undefined): Date | null {
  if (!s) return null;
  const iso = String(s).replace(' ', 'T');
  // Already has TZ info — leave it alone.
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) return new Date(iso);
  return new Date(iso + 'Z');
}

// ─── shared row / metric shapes ──────────────────────────────────────────

/** Row returned by db.digSessionsForDate (DigSessionRow + parsed result/preview). */
interface DigSessionWithResult extends DigSessionRow {
  result: DigResultJson | null;
  preview: unknown;
}

interface DigResultJson {
  summary?: string;
  sources?: { url?: string; title?: string; snippet?: string }[];
}

/** Row returned by db.listServerEventsForDate (ServerEventRow + parsed details). */
interface ServerEventWithDetails {
  id: number;
  type: 'start' | 'stop' | 'downtime' | 'restart';
  occurred_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  details_json: string | null;
  details: unknown;
}

/** Row returned by db.activityEventsForDate (subset cols + parsed metadata). */
interface ActivityEventWithMetadata {
  id: number;
  kind: ActivityKind;
  occurred_at: string;
  source: string | null;
  ref_id: string | null;
  content: string | null;
  metadata_json: string | null;
  metadata: unknown;
}

/** GPS row subset returned by db.listGpsLocationsForDate (cols selected by query). */
type GpsPointRow = Pick<
  GpsLocationRow,
  'id' | 'device_id' | 'recorded_at' | 'lat' | 'lon'
  | 'accuracy_m' | 'altitude_m' | 'velocity_kmh' | 'course_deg'
  | 'samples_count' | 'samples_first_at'
  | 'place_name' | 'place_address' | 'place_source'
>;

/** Stored shape of meal `additions_json`. */
interface MealAddition {
  name: string;
  calories: number | null;
  added_at?: string | null;
}

/** Stored shape of meal `nutrients_json`. */
interface MealNutrients {
  protein_g?: number | null;
  fat_g?: number | null;
  carbs_g?: number | null;
  fiber_g?: number | null;
  sugar_g?: number | null;
  sodium_mg?: number | null;
}

interface MealSummary {
  id: number;
  eaten_at: string;
  description: string | null;
  base_calories: number | null;
  addition_calories: number;
  total_calories: number | null;
  nutrients: MealNutrients | null;
  additions: { name: string; calories: number | null; added_at: string | null }[];
  location_label: string | null;
  ai_status: MealRow['ai_status'];
  user_note: string | null;
}

interface TopDomain {
  domain: string;
  count: number;
  active_hours: number[];
  site_name?: string | null;
  description?: string | null;
  can_do?: string | null;
  kind?: string | null;
  catalog_title?: string | null;
  domain_private?: boolean;
}

interface DigSummary {
  id: number;
  query: string;
  status: DigSessionRow['status'];
  created_at: string;
  summary: string;
  source_count: number;
  sources: { url: string; title: string; snippet: string }[];
}

interface DowntimeBlock {
  from: string;
  to: string | null;
  duration_ms: number | null;
}

export interface GpsSummary {
  points: number;
  raw_publishes: number;
  compressed_segments: number;
  devices: string[];
  distance_meters: number;
  bbox: { lat: [number, number]; lon: [number, number] } | null;
  midpoint: { lat: number; lon: number } | null;
  hours: number[];
  first_at: string | null;
  last_at: string | null;
  /** alias used by formatGpsBlock — kept for legacy callers */
  distance_m?: number;
}

interface UserProfile {
  age: number;
  sex: 'male' | 'female';
  weight_kg: number;
  height_cm: number;
  activity_level: string;
}

interface CaloricBalance {
  profile: UserProfile;
  bmr: number;
  tdee: number;
  walking_kcal: number;
  intake: number | null;
  expenditure_total: number;
  diff_vs_target: number | null;
  diff_vs_expenditure: number | null;
}

interface ActivityItem {
  id: number;
  kind: ActivityKind;
  occurred_at: string;
  source: string | null;
  ref_id: string | null;
  content: string | null;
  metadata: unknown;
}

interface ActivitySummary {
  total: number;
  kinds: Partial<Record<ActivityKind, number>>;
  hourly: Partial<Record<ActivityKind, number[]>>;
  items: ActivityItem[];
  page: { limit: number | null; offset: number; returned: number };
}

interface BookmarksForDateResult {
  created: BookmarkCreatedRow[];
  accessed: BookmarkAccessedRow[];
  created_total: number;
  accessed_total: number;
}

interface BookmarkCreatedRow {
  id: number;
  url: string;
  title: string;
  summary: string | null;
  created_at: string;
}

interface BookmarkAccessedRow {
  id: number;
  url: string;
  title: string;
  first_accessed_at: string;
  last_accessed_at: string;
  access_count: number;
}

export interface AggregatedDay {
  date: string;
  total_events: number;
  unique_domains: number;
  hourly_visits: number[];
  top_domains: TopDomain[];
  active_hours: number[];
  first_event_at: string | null;
  last_event_at: string | null;
  bookmarks: BookmarksForDateResult;
  digs: DigSummary[];
  digs_total: number;
  downtimes: DowntimeBlock[];
  total_downtime_ms: number;
  gps: GpsSummary;
  meals: MealSummary[];
  meals_total_calories: number | null;
  meals_nutrients: Record<string, number> | null;
  meals_pfc_label: string | null;
  caloric_balance: CaloricBalance | null;
  activity: ActivitySummary;
  apps: AppUsageSummary | null;
  games: GameUsageSummary | null;
  sources: {
    visit_events: number;
    page_visits: number;
    activity_events: number;
  };
}

export interface AppUsageItem {
  process_name: string;
  display_name: string;
  kind: string | null;
  minutes: number;
  active_minutes: number;
}
export interface AppUsageKindTotal { kind: string; minutes: number; active_minutes: number }
export interface AppUsageSummary {
  total_minutes: number;
  active_minutes: number;
  by_kind: AppUsageKindTotal[];
  top: AppUsageItem[];
}

export interface GameUsageItem {
  appid: number;
  name: string;
  minutes: number;
  first_at: string;
  last_at: string;
}
export interface GameUsageSummary {
  total_minutes: number;
  items: GameUsageItem[];
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

// 開発活動 (git commit / Claude Code prompt) は件数が多くなりがちなので、
// 初期表示は別途 100 件まで。 古い側は API ページングで取得 (more ▽)。
const ACTIVITY_LIST_INITIAL = 100;

interface AggregateDayOptions {
  listLimit?: number | null;
  activityLimit?: number | null;
}

export function aggregateDay(
  db: Db,
  dateStr: string,
  { listLimit = DIARY_LIST_INITIAL, activityLimit = ACTIVITY_LIST_INITIAL }: AggregateDayOptions = {},
): AggregatedDay {
  const hourlyVisits: number[] = new Array(24).fill(0);
  const domainTally = new Map<string, number>();
  const domainHours = new Map<string, Set<number>>(); // domain -> Set of hour buckets seen
  let firstSeen: string | null = null;
  let lastSeen: string | null = null;

  // 1) Per-event log
  const events = visitEventsForDate(db, dateStr) as VisitEventRow[];
  for (const e of events) {
    const localHour = parseSqliteUtc(e.visited_at)?.getHours();
    const hour = Number.isFinite(localHour) ? (localHour as number) : 0;
    hourlyVisits[hour] += 1;
    if (!firstSeen || e.visited_at < firstSeen) firstSeen = e.visited_at;
    if (!lastSeen || e.visited_at > lastSeen) lastSeen = e.visited_at;
    if (e.domain) {
      domainTally.set(e.domain, (domainTally.get(e.domain) || 0) + 1);
      if (!domainHours.has(e.domain)) domainHours.set(e.domain, new Set<number>());
      domainHours.get(e.domain)!.add(hour);
    }
  }

  // 2) Per-URL log (page_visits) — every URL touched on this date adds another hit.
  const visits = db.prepare(`
    SELECT v.url, v.last_seen_at
    FROM page_visits v
    WHERE date(v.last_seen_at, 'localtime') = ?
  `).all(dateStr) as { url: string; last_seen_at: string }[];
  let pageVisitsContribution = 0;
  for (const v of visits) {
    const domain = extractDomain(v.url);
    if (!domain) continue;
    let hour = 0;
    try {
      const h = parseSqliteUtc(v.last_seen_at)?.getHours();
      hour = Number.isFinite(h) ? (h as number) : 0;
    } catch { /* ignore */ }
    hourlyVisits[hour] += 1;
    pageVisitsContribution += 1;
    domainTally.set(domain, (domainTally.get(domain) || 0) + 1);
    if (!domainHours.has(domain)) domainHours.set(domain, new Set<number>());
    domainHours.get(domain)!.add(hour);
    if (!firstSeen || v.last_seen_at < firstSeen) firstSeen = v.last_seen_at;
    if (!lastSeen || v.last_seen_at > lastSeen) lastSeen = v.last_seen_at;
  }

  const topDomainList: TopDomain[] = [...domainTally.entries()]
    .map(([domain, count]) => ({
      domain,
      count,
      active_hours: [...(domainHours.get(domain) || [])].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  const catalog = getDomainCatalogMap(db, topDomainList.map(d => d.domain)) as Map<string, DomainCatalogRow>;
  const topDomains: TopDomain[] = topDomainList.map(d => {
    const cat = catalog.get(d.domain);
    return cat ? {
      ...d,
      site_name: cat.site_name || null,
      description: cat.description || null,
      can_do: cat.can_do || null,
      kind: cat.kind || null,
      catalog_title: cat.title || null,
      domain_private: !!cat.domain_private,
    } : d;
  }).filter(d => !d.domain_private);

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
  const allDigs = digSessionsForDate(db, dateStr) as DigSessionWithResult[];
  const digsTotal = allDigs.length;
  const digSlice = listLimit == null ? allDigs : allDigs.slice(0, listLimit);
  const digs: DigSummary[] = digSlice.map(d => {
    const r = d.result || {};
    const sources = Array.isArray(r.sources) ? r.sources : [];
    return {
      id: d.id,
      query: d.query,
      status: d.status,
      created_at: d.created_at,
      summary: (r.summary || '').slice(0, 600),
      source_count: sources.length,
      sources: sources.slice(0, 8).map(s => ({
        url: s.url || '',
        title: s.title || '',
        snippet: (s.snippet || '').slice(0, 200),
      })),
    };
  });

  // Surface significant server downtimes so claude knows the data is partial.
  const serverEvents = listServerEventsForDate(db, dateStr) as ServerEventWithDetails[];
  const downtimes: DowntimeBlock[] = serverEvents
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
  const gpsPoints = listGpsLocationsForDate(db, dateStr) as GpsPointRow[];
  const gps = summarizeGpsForDate(gpsPoints);

  // 食事ログ — eaten_at がその日に該当する meal をすべて拾う。
  // 総カロリーは「base (user_corrected_calories ?? calories) + sum(additions[].calories)」 を
  // 各レコードで計算した合計。 calories null 値は 0 として扱う (ユーザが
  // 不明としたものを過大計上しないため、 集計上は欠損扱い)。
  const mealsRows = listMealsForDate(db, dateStr) as MealRow[];
  const meals: MealSummary[] = mealsRows.map((m) => {
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
  const nutrientKeys = ['protein_g', 'fat_g', 'carbs_g', 'fiber_g', 'sugar_g', 'sodium_mg'] as const;
  const nutrientsSum: Record<string, number> = Object.fromEntries(nutrientKeys.map((k) => [k, 0]));
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
  let pfcLabel: string | null = null;
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

  // 開発活動イベント (git commit / Claude Code prompt 等)。 ブラウザ閲覧で
  // 拾えない作業をカバーする。 hourly + 集計は全件から、 items は最新
  // activityLimit 件 (DESC、 新しい順) にして UI 側でページングできるよう
  // total を渡す。
  const allActivity = activityEventsForDate(db, dateStr) as ActivityEventWithMetadata[];
  const activity = summarizeActivityForDate(allActivity, activityLimit ?? null);

  // アプリ使用 (フォアグラウンドプロセスの秒積算) と Steam ゲーム時間。
  // どちらも 0 件のときは null を返して prompt 側で「(なし)」 にする。
  const appsRaw = appUsageForDate(db, dateStr) as AppUsageRow[];
  const gamesRaw = gameUsageForDate(db, dateStr) as GameUsageRow[];
  const apps = summarizeAppUsage(appsRaw);
  const games = summarizeGameUsage(gamesRaw);

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
      gpsDistanceM: gps?.distance_meters ?? 0,
    }),
    activity,
    apps,
    games,
    sources: {
      visit_events: events.length,
      page_visits: pageVisitsContribution,
      activity_events: allActivity.length,
    },
  };
}

function summarizeAppUsage(rows: AppUsageRow[]): AppUsageSummary | null {
  if (!rows.length) return null;
  // 短すぎる (= 30 秒未満) は誤検出が多いので捨てる。
  const filtered = rows.filter((r) => r.total_sec >= 30);
  if (!filtered.length) return null;
  const items: AppUsageItem[] = filtered.map((r) => ({
    process_name: r.process_name,
    display_name: r.name?.trim() || r.process_name,
    kind: r.kind || null,
    minutes: Math.round(r.total_sec / 60),
    active_minutes: Math.round(r.active_sec / 60),
  })).filter((it) => it.minutes >= 1);
  if (!items.length) return null;
  const kindMap = new Map<string, { minutes: number; active_minutes: number }>();
  for (const it of items) {
    const k = it.kind || 'unknown';
    const cur = kindMap.get(k) ?? { minutes: 0, active_minutes: 0 };
    cur.minutes += it.minutes;
    cur.active_minutes += it.active_minutes;
    kindMap.set(k, cur);
  }
  const by_kind: AppUsageKindTotal[] = [...kindMap.entries()]
    .map(([kind, v]) => ({ kind, minutes: v.minutes, active_minutes: v.active_minutes }))
    .sort((a, b) => b.minutes - a.minutes);
  const totalMinutes = items.reduce((s, it) => s + it.minutes, 0);
  const activeMinutes = items.reduce((s, it) => s + it.active_minutes, 0);
  return {
    total_minutes: totalMinutes,
    active_minutes: activeMinutes,
    by_kind,
    top: items.slice(0, 15),
  };
}

function summarizeGameUsage(rows: GameUsageRow[]): GameUsageSummary | null {
  if (!rows.length) return null;
  const items: GameUsageItem[] = rows
    .filter((r) => r.minutes_played >= 1)
    .map((r) => ({
      appid: r.appid,
      name: r.name?.trim() || `appid:${r.appid}`,
      minutes: r.minutes_played,
      first_at: r.first_at,
      last_at: r.last_at,
    }));
  if (!items.length) return null;
  return {
    total_minutes: items.reduce((s, it) => s + it.minutes, 0),
    items,
  };
}

function formatMinutes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0m';
  if (n < 60) return `${n}m`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

const APP_KIND_LABEL: Record<string, string> = {
  game: '🎮 ゲーム',
  work: '💼 仕事',
  browser: '🌐 ブラウザ',
  messaging: '💬 メッセージ',
  media: '🎬 メディア',
  creative: '🎨 クリエイティブ',
  other: '❓ その他',
  unknown: '❔ 未分類',
};

function formatAppsBlock(apps: AppUsageSummary | null | undefined): string {
  if (!apps || apps.top.length === 0) return '(アプリ使用記録なし)';
  const lines: string[] = [];
  lines.push(`合計フォアグラウンド時間: ${formatMinutes(apps.total_minutes)} (入力アクティブ: ${formatMinutes(apps.active_minutes)})`);
  if (apps.by_kind.length > 0) {
    const kindStr = apps.by_kind
      .filter((k) => k.minutes >= 1)
      .map((k) => `${APP_KIND_LABEL[k.kind] || k.kind} ${formatMinutes(k.minutes)}`)
      .join(' / ');
    if (kindStr) lines.push(`カテゴリ別: ${kindStr}`);
  }
  lines.push('上位アプリ:');
  for (const it of apps.top) {
    const tag = APP_KIND_LABEL[it.kind || 'unknown'] || it.kind || '';
    const act = it.active_minutes > 0 && it.active_minutes !== it.minutes
      ? ` (入力 ${formatMinutes(it.active_minutes)})` : '';
    lines.push(`- ${tag} ${it.display_name}: ${formatMinutes(it.minutes)}${act}`);
  }
  return lines.join('\n');
}

function formatGamesBlock(games: GameUsageSummary | null | undefined): string {
  if (!games || games.items.length === 0) return '(プレイ記録なし)';
  const lines: string[] = [];
  lines.push(`合計プレイ時間: ${formatMinutes(games.total_minutes)} (Steam playtime_forever の delta)`);
  for (const g of games.items) {
    const startHH = g.first_at?.slice(11, 16);
    const endHH = g.last_at?.slice(11, 16);
    const span = (startHH && endHH && startHH !== endHH) ? ` (${startHH}〜${endHH})` : '';
    lines.push(`- 🎮 ${g.name}: ${formatMinutes(g.minutes)}${span}`);
  }
  return lines.join('\n');
}

/**
 * 当日分の活動イベントを集計する。
 *
 * - hourly: kind 別の 24 時間バケット (バーグラフ用、 全件から計算)
 * - kinds:  kind 別の総件数 (全件から計算)
 * - items:  **最新 listLimit 件** (DESC、 新しいが先頭)。 listLimit==null なら全件。
 *           UI のリスト表示用、 古い側は API (`/api/activity/events?offset=...`) で
 *           ページングする。
 * - total:  全イベント件数
 *
 * 入力 rows は時刻昇順 (activityEventsForDate の出力) を想定。
 */
function summarizeActivityForDate(
  rows: ActivityEventWithMetadata[],
  listLimit: number | null,
): ActivitySummary {
  const kinds: Partial<Record<ActivityKind, number>> = {};
  const hourly: Partial<Record<ActivityKind, number[]>> = {};
  for (const r of rows) {
    kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    if (!hourly[r.kind]) hourly[r.kind] = new Array(24).fill(0);
    const h = parseSqliteUtc(r.occurred_at)?.getHours();
    if (Number.isFinite(h)) hourly[r.kind]![h as number] += 1;
  }
  // 最新 listLimit 件 = rows の末尾から listLimit 件、 reverse して DESC に
  const sliced = listLimit == null
    ? [...rows].reverse()
    : rows.slice(-Math.max(0, listLimit)).reverse();
  const items: ActivityItem[] = sliced.map((r) => ({
    id: r.id,
    kind: r.kind,
    occurred_at: r.occurred_at,
    source: r.source,
    ref_id: r.ref_id,
    content: r.content,
    metadata: r.metadata,
  }));
  return {
    total: rows.length,
    kinds,
    hourly,
    items,
    // UI が next page を組み立てる時の参考に渡しておく (offset = items.length が次の起点)
    page: {
      limit: listLimit,
      offset: 0,
      returned: items.length,
    },
  };
}

function parseMealAdditions(json: string | null): MealAddition[] {
  if (!json) return [];
  try {
    const arr: unknown = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter((v): v is MealAddition => !!v && typeof v === 'object'
      && typeof (v as { name?: unknown }).name === 'string');
  } catch {
    return [];
  }
}

function parseMealNutrients(json: string | null): MealNutrients | null {
  if (!json) return null;
  try {
    const o: unknown = JSON.parse(json);
    return (o && typeof o === 'object') ? (o as MealNutrients) : null;
  } catch {
    return null;
  }
}

// ─── カロリーバランス計算 ───────────────────────────────────────
//
// app_settings の `user.*` から profile を読み出し、 BMR / TDEE を計算。
// 摂取 (食事合計) / 消費 (BMR + 軌跡歩行) / 適正 (TDEE) / 過不足 を出す。
//
// プロファイル未設定の場合は null を返し、 UI 側で「設定してください」 と促す。

const ACTIVITY_FACTORS: Record<string, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

function loadUserProfile(db: Db): UserProfile | null {
  const s = getAppSettings(db) as Record<string, string | null | undefined>;
  const age = parseFloat(s['user.age'] || '');
  const sex = (s['user.sex'] || '').trim().toLowerCase();
  const weight = parseFloat(s['user.weight_kg'] || '');
  const height = parseFloat(s['user.height_cm'] || '');
  const activity = (s['user.activity_level'] || 'moderate').trim().toLowerCase();
  if (!isFinite(age) || !isFinite(weight) || !isFinite(height) || (sex !== 'male' && sex !== 'female')) {
    return null;
  }
  return { age, sex, weight_kg: weight, height_cm: height, activity_level: activity };
}

function computeBmrMifflin(profile: UserProfile): number {
  // Mifflin-St Jeor
  const base = 10 * profile.weight_kg + 6.25 * profile.height_cm - 5 * profile.age;
  return profile.sex === 'male' ? base + 5 : base - 161;
}

function computeCaloricBalance(
  db: Db,
  { intake, gpsDistanceM }: { intake: number | null; gpsDistanceM: number },
): CaloricBalance | null {
  const profile = loadUserProfile(db);
  if (!profile) return null;
  const bmr = Math.round(computeBmrMifflin(profile));
  const factor = ACTIVITY_FACTORS[profile.activity_level] ?? ACTIVITY_FACTORS.moderate;
  const tdee = Math.round(bmr * factor);
  // 歩行による追加消費 (m → kcal): 1 km あたり 体重 × 0.6 kcal の概算
  const walkingKcal = Math.round((gpsDistanceM || 0) / 1000 * profile.weight_kg * 0.6);
  // 1 日消費 = BMR + 軌跡からの歩行追加 (TDEE の活動係数とは別の上乗せで見せる)
  const expenditure = bmr + walkingKcal;
  const intakeNum = (typeof intake === 'number' && isFinite(intake)) ? intake : null;
  return {
    profile,
    bmr,
    tdee,
    walking_kcal: walkingKcal,
    intake: intakeNum,
    expenditure_total: expenditure, // BMR + walking
    diff_vs_target: intakeNum != null ? intakeNum - tdee : null,
    diff_vs_expenditure: intakeNum != null ? intakeNum - expenditure : null,
  };
}

// Haversine 距離 (m)。地球半径 6371008 m (mean)。短距離では誤差は数 cm 以下。
function haversineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6_371_008;
  const toRad = (d: number): number => (d * Math.PI) / 180;
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
export function summarizeGpsForDate(points: GpsPointRow[] | null | undefined): GpsSummary {
  if (!points || points.length === 0) {
    return {
      points: 0,
      raw_publishes: 0,
      compressed_segments: 0,
      devices: [],
      distance_meters: 0,
      bbox: null,
      midpoint: null,
      hours: [],
      first_at: null,
      last_at: null,
    };
  }
  const devices = new Set<string>();
  const hourSet = new Set<number>();
  let minLat = +Infinity, maxLat = -Infinity;
  let minLon = +Infinity, maxLon = -Infinity;
  let rawPublishes = 0;
  let compressedSegments = 0;
  // 距離は **device 別に独立計算** して合算する。 異 device の点列を
  // 時系列でつないで haversine を取ると、 端末間で 100km 級の幻 jump が
  // 「移動」 として加算されてしまう (例: test-dev と iphone を混ぜた時の
  // 107km 誤計上)。 device ごとに run を分ければこの誤計上は起きない。
  const byDevice = new Map<string, GpsPointRow[]>();
  for (const p of points) {
    const dev = p.device_id || '(none)';
    if (p.device_id) devices.add(p.device_id);
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    const h = parseSqliteUtc(p.recorded_at)?.getHours();
    if (Number.isFinite(h)) hourSet.add(h as number);
    rawPublishes += Number.isFinite(p.samples_count) && p.samples_count > 0 ? p.samples_count : 1;
    if ((p.samples_count || 1) > 1) compressedSegments++;
    if (!byDevice.has(dev)) byDevice.set(dev, []);
    byDevice.get(dev)!.push(p);
  }
  let dist = 0;
  for (const list of byDevice.values()) {
    let prev: GpsPointRow | null = null;
    for (const p of list) {
      if (prev) {
        // accuracy なし or > 200m の点は連続性を信頼しない
        const accOk = !p.accuracy_m || p.accuracy_m < 200;
        if (accOk) dist += haversineMeters(prev, p);
      }
      prev = p;
    }
  }
  return {
    points: points.length,
    raw_publishes: rawPublishes,
    compressed_segments: compressedSegments,
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

// ─── GitHub API 連携 ──────────────────────────────────────────────

interface GithubCommit {
  repo: string;
  sha: string;
  message: string;
  author: string;
  created_at: string;
  url: string;
}

export interface GithubActivityResult {
  commits?: GithubCommit[];
  errors?: string[];
  fetched_at?: string;
  error?: string;
}

interface GithubApiCommit {
  sha?: string;
  html_url?: string;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
    committer?: { date?: string };
  };
  author?: { login?: string };
  repository?: { full_name?: string };
  _repo?: string;
}

interface GithubSearchResponse {
  items?: GithubApiCommit[];
}

export interface FetchGithubActivityArgs {
  token?: string | null;
  user?: string | null;
  repos?: string[] | null;
  dateStr: string;
  timeoutMs?: number;
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
export async function fetchGithubActivity({
  token, user, repos, dateStr, timeoutMs = 60_000,
}: FetchGithubActivityArgs): Promise<GithubActivityResult | null> {
  if (!user) return null;

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Memoria-diary/0.1',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const since = `${dateStr}T00:00:00Z`;
  const until = `${dateStr}T23:59:59Z`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const commits: GithubCommit[] = [];
  const errors: string[] = [];

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
        const arr = await res.json() as GithubApiCommit[];
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
      const data = await res.json() as GithubSearchResponse;
      for (const c of (data.items || [])) {
        commits.push(formatCommit({ ...c, _repo: c.repository?.full_name }));
      }
    }
    return {
      commits,
      errors: errors.length ? errors : undefined,
      fetched_at: new Date().toISOString(),
    };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function formatCommit(c: GithubApiCommit): GithubCommit {
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

interface GithubProbe {
  name: string;
  url: string;
  status?: number;
  ok?: boolean;
  body?: string;
  error?: string;
}

interface TokenFormat {
  classic: boolean;
  fine_grained: boolean;
  length: number;
}

export interface PingGithubResult {
  ok: boolean;
  status?: number;
  login?: string;
  scopes?: string;
  hint?: string;
  error?: string;
  token_format: TokenFormat;
  probes: GithubProbe[];
}

export interface PingGithubArgs {
  token?: string | null;
  user?: string | null;
  timeoutMs?: number;
}

/**
 * Probe a few GitHub endpoints to figure out *why* a PAT is failing — a single
 * /user call can return 401 simply because a fine-grained PAT lacks Account
 * permissions, even though the token itself is valid.
 */
export async function pingGithub({
  token, user, timeoutMs = 60_000,
}: PingGithubArgs): Promise<PingGithubResult> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Memoria-diary/0.1',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  const fmt: TokenFormat = {
    classic: !!(token && /^gh[pousr]_/.test(token)),
    fine_grained: !!(token && /^github_pat_/.test(token)),
    length: token ? token.length : 0,
  };

  const probes: GithubProbe[] = [];
  async function tryProbe(name: string, url: string): Promise<Response | null> {
    try {
      const res = await fetch(url, { headers, signal: ac.signal });
      let body = '';
      if (!res.ok) body = (await res.text()).slice(0, 200);
      probes.push({ name, url, status: res.status, ok: res.ok, body });
      return res;
    } catch (e: unknown) {
      probes.push({ name, url, error: e instanceof Error ? e.message : String(e) });
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
      const data = await userRes.json() as { login?: string };
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
  } catch (e: unknown) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      token_format: fmt,
      probes,
    };
  } finally {
    clearTimeout(timer);
  }
}

function inferAuthHint({ probes, fmt }: { probes: GithubProbe[]; fmt: TokenFormat }): string {
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
export function bookmarksForDate(
  db: Db,
  dateStr: string,
  { limit = null, offset = 0 }: { limit?: number | null; offset?: number } = {},
): BookmarksForDateResult {
  const limitClause = limit == null ? '' : ' LIMIT ? OFFSET ?';
  const args: (string | number)[] = limit == null
    ? [dateStr]
    : [dateStr, Number(limit) || 0, Number(offset) || 0];

  const createdTotal = (db.prepare(`
    SELECT COUNT(*) AS n FROM bookmarks WHERE date(created_at, 'localtime') = ?
  `).get(dateStr) as { n: number }).n;
  const created = db.prepare(`
    SELECT id, url, title, summary, created_at
    FROM bookmarks
    WHERE date(created_at, 'localtime') = ?
    ORDER BY created_at ASC
    ${limitClause}
  `).all(...args) as BookmarkCreatedRow[];

  const accessedTotal = (db.prepare(`
    SELECT COUNT(DISTINCT b.id) AS n
    FROM accesses a
    JOIN bookmarks b ON b.id = a.bookmark_id
    WHERE date(a.accessed_at, 'localtime') = ?
  `).get(dateStr) as { n: number }).n;
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
  `).all(...args) as BookmarkAccessedRow[];

  return {
    created, accessed: accessedRows,
    created_total: createdTotal,
    accessed_total: accessedTotal,
  };
}

export interface GithubByRepo {
  repos: { repo: string; count: number; samples: { sha: string; message: string }[] }[];
  total: number;
}

/** GitHub commits grouped by repository: { byRepo: {repo: count}, total, repos: [...] }. */
export function summarizeGithubByRepo(github: { commits?: GithubCommit[] } | null | undefined): GithubByRepo {
  const commits = github?.commits || [];
  const byRepo = new Map<string, { count: number; samples: { sha: string; message: string }[] }>();
  for (const c of commits) {
    const r = c.repo || '(unknown)';
    if (!byRepo.has(r)) byRepo.set(r, { count: 0, samples: [] });
    const cur = byRepo.get(r)!;
    cur.count += 1;
    if (cur.samples.length < 3) cur.samples.push({ sha: c.sha, message: c.message });
  }
  const repos = [...byRepo.entries()]
    .map(([repo, v]) => ({ repo, count: v.count, samples: v.samples }))
    .sort((a, b) => b.count - a.count);
  return { repos, total: commits.length };
}

interface WorkContentPromptArgs {
  dateStr: string;
  urlList: string;
  activityList: string;
  totalEvents: number;
  totalDomains: number;
  activityCounts: string | null;
  appsBlock: string;
  gamesBlock: string;
}

const WORK_CONTENT_PROMPT = ({ dateStr, urlList, activityList, totalEvents, totalDomains, activityCounts, appsBlock, gamesBlock }: WorkContentPromptArgs): string => [
  `あなたは ${dateStr} の「作業内容」セクションを書きます。`,
  'ブラウザ閲覧履歴 (URL + 時刻) と開発活動 (git commit / Claude Code への指示) を両方読み、',
  '**大まかな時間帯**で何をしていたかを 1 文でまとめ、',
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
  '- **重要**: 開発活動 (git commit / Claude Code への指示) は強い作業シグナル。',
  '  ブラウザ履歴が空でも、 commit / 指示が連続している時間帯は作業していたとみなす。',
  '  特にスマホ開発・ターミナル中心の作業日はブラウザ履歴がほぼ無いので、',
  '  開発活動を主たる根拠にして時間帯を組み立てる。',
  '- 24 時間 (1440 分) を超えてはいけない。実態として 12 時間を超えるのは長時間集中日のみ。',
  '- 推定材料が足りない (例: 1 件しかアクセスがない、 開発活動も 0) 場合は WORK_MINUTES: 0 と書く。',
  '',
  `日付: ${dateStr}`,
  `総アクセス: ${totalEvents}`,
  `ユニークドメイン: ${totalDomains}`,
  `開発活動: ${activityCounts || '(なし)'}`,
  '',
  'URL 履歴 (時刻 + URL):',
  urlList || '(ブラウザ閲覧記録なし)',
  '',
  '開発活動 (時刻 + イベント):',
  activityList || '(なし)',
  '',
  'アプリ使用 (フォアグラウンド時間、 入力アクティブ秒):',
  appsBlock,
  '',
  'ゲームプレイ (Steam playtime delta):',
  gamesBlock,
  '',
  '※ アプリ / ゲーム情報は時間帯まとめの根拠として使う。 例:',
  '  - 🎮 ゲーム合計が長い時間帯 → 「ゲームをしていた」 として 1 ブロック',
  '  - 💼 仕事 / 🎨 クリエイティブ系アプリの時間 → 作業として扱う (URL の薄い日でも作業時間として認める)',
  '  - 「主な作業」 に具体アプリ名 (VSCode / Photoshop / 特定ゲーム名) を入れて良い',
  '  - WORK_MINUTES の見積もりにアプリ入力アクティブ秒も考慮する (= 仕事系アプリの active_min は作業時間)。 ゲームは作業に含めない。',
].join('\n');

export interface WorkMinutesExtraction {
  content: string;
  workMinutes: number | null;
}

/**
 * Pull `WORK_MINUTES: <int>` off the tail of the Sonnet output and return both
 * the cleaned narrative and the parsed minutes. Sonnet is asked to put this
 * line at the very end with a blank line before it; we tolerate any trailing
 * whitespace and missing blank line. Anything outside [0, 1440] is dropped.
 */
export function extractWorkMinutes(raw: string | null | undefined): WorkMinutesExtraction {
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

function formatGpsBlock(metrics: AggregatedDay | null | undefined): string {
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

function formatDowntimeBlock(metrics: AggregatedDay | null | undefined): string {
  const dts = metrics?.downtimes || [];
  if (!dts.length) return '(なし)';
  return dts.map(d => {
    const from = (d.from || '').replace('T', ' ').slice(0, 19);
    const to = (d.to || '').replace('T', ' ').slice(0, 19);
    const mins = Math.round((d.duration_ms || 0) / 60_000);
    return `- ${from} 〜 ${to} (${mins} 分間 Memoria サーバ停止 → アクセスログ取得なし)`;
  }).join('\n');
}

function formatCaloricBalanceBlock(metrics: AggregatedDay | null | undefined): string {
  const cb = metrics?.caloric_balance;
  if (!cb) return '(ユーザプロファイル未設定 — 設定 → AI / 連携 で年齢 / 性別 / 体重 / 身長 / 活動レベルを入れてください)';
  const p = cb.profile;
  const lines: string[] = [];
  lines.push(`プロファイル: ${p.sex === 'male' ? '男性' : '女性'} / ${p.age}歳 / ${p.weight_kg}kg / ${p.height_cm}cm / 活動 ${p.activity_level}`);
  lines.push(`基礎代謝 (BMR): 約 ${cb.bmr} kcal`);
  lines.push(`適正カロリー (TDEE = BMR × 活動係数): 約 ${cb.tdee} kcal`);
  lines.push(`軌跡からの歩行消費: 約 ${cb.walking_kcal} kcal`);
  lines.push(`1 日消費 (BMR + 歩行): 約 ${cb.expenditure_total} kcal`);
  if (cb.intake != null) {
    lines.push(`摂取カロリー (食事合計): 約 ${cb.intake} kcal`);
    const diffT = cb.diff_vs_target;
    const diffE = cb.diff_vs_expenditure;
    lines.push(`摂取 - 適正: ${(diffT ?? 0) > 0 ? '+' : ''}${diffT} kcal`);
    lines.push(`摂取 - 消費 (収支): ${(diffE ?? 0) > 0 ? '+' : ''}${diffE} kcal (プラス = 余剰、 マイナス = 不足)`);
  } else {
    lines.push('摂取カロリー: (食事の記録なし)');
  }
  return lines.join('\n');
}

function formatMealsBlock(metrics: AggregatedDay | null | undefined): string {
  const meals = metrics?.meals || [];
  if (!meals.length) return '(食事の記録なし)';
  const lines: string[] = meals.map((m) => {
    const t = formatLocalHm(m.eaten_at); // localtime HH:MM (UTC ISO を local 化)
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
  const total = (typeof metrics?.meals_total_calories === 'number') ? metrics.meals_total_calories : null;
  if (total != null) lines.push(`総カロリー (推定): 約 ${total} kcal`);
  const nut = metrics?.meals_nutrients;
  if (nut) {
    const fmt = (k: string, unit: string): string => (typeof nut[k] === 'number' && isFinite(nut[k]))
      ? `${Math.round(nut[k] * 10) / 10}${unit}` : '—';
    lines.push(`栄養素合計 (推定): P ${fmt('protein_g', 'g')} / F ${fmt('fat_g', 'g')} / C ${fmt('carbs_g', 'g')} / 食物繊維 ${fmt('fiber_g', 'g')} / 糖質 ${fmt('sugar_g', 'g')} / 塩分 ${fmt('sodium_mg', 'mg')}`);
    if (metrics?.meals_pfc_label) lines.push(`PFC バランス: ${metrics.meals_pfc_label}`);
    lines.push('※ 栄養素は写真 + 食品名から AI が推定した概数。 厳密な値ではない。');
  }
  return lines.join('\n');
}

function formatActivityBlock(activity: ActivitySummary | null | undefined): string {
  if (!activity || !activity.total) return '(なし)';
  const lines: string[] = [];
  const counts = formatActivityCounts(activity);
  if (counts) lines.push(`- 合計: ${counts}`);
  // 最大 30 件まで時刻昇順で並べる (highlights プロンプトのサイズ管理)。
  const sorted = [...(activity.items || [])].sort((a, b) => {
    const at = parseSqliteUtc(a.occurred_at)?.getTime() || 0;
    const bt = parseSqliteUtc(b.occurred_at)?.getTime() || 0;
    return at - bt;
  }).slice(0, 30);
  for (const it of sorted) {
    const t = formatLocalHm(it.occurred_at);
    const tag = it.kind === 'git_commit' ? 'git'
      : it.kind === 'claude_code_prompt' ? 'cc'
      : it.kind;
    const src = it.source ? ` ${it.source}:` : '';
    const content = (it.content || '').replace(/\s+/g, ' ').slice(0, 140);
    lines.push(`- ${t} [${tag}]${src} ${content}`.trim());
  }
  if ((activity.items || []).length > 30) {
    lines.push(`- … ほか ${activity.items.length - 30} 件`);
  }
  return lines.join('\n');
}

function formatLocalHm(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(11, 16);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface BookmarkSummary {
  created: number;
  accessed: number;
  topDomains: string[];
}

interface HighlightsPromptArgs {
  dateStr: string;
  workContent: string;
  githubByRepo: GithubByRepo;
  bookmarkSummary: BookmarkSummary;
  digs: DigSummary[];
  notes: string | null | undefined;
  metrics: AggregatedDay;
}

const HIGHLIGHTS_PROMPT = ({ dateStr, workContent, githubByRepo, bookmarkSummary, digs, notes, metrics }: HighlightsPromptArgs): string => [
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
  '## 入力 3b: ローカル開発活動 (git commit + Claude Code 指示)',
  formatActivityBlock(metrics.activity),
  '',
  '## 入力 3c: アプリ使用 (フォアグラウンド時間)',
  formatAppsBlock(metrics.apps),
  '',
  '## 入力 3d: ゲームプレイ (Steam playtime delta)',
  formatGamesBlock(metrics.games),
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
  '## カロリーバランス (適正 vs 摂取 vs 消費)',
  formatCaloricBalanceBlock(metrics),
  '',
  notes ? `## ユーザのメモ・補足 (反映してください)\n${notes}\n` : '',
  '',
  '出力フォーマット (markdown のみ。前置き不要):',
  '- ハイライト1',
  '- ハイライト2',
].join('\n');

/**
 * Build the URL list for the work-content prompt. Format: "HH:MM <url>" per line,
 * deduped consecutively (collapse runs of the same URL within 2 minutes).
 */
function buildUrlList(db: Db, dateStr: string): string {
  const events = visitEventsForDate(db, dateStr) as VisitEventRow[];
  if (events.length === 0) {
    // Fall back to page_visits where last_seen is the date.
    const visits = db.prepare(`
      SELECT v.url, v.last_seen_at FROM page_visits v
      WHERE date(v.last_seen_at, 'localtime') = ?
      ORDER BY v.last_seen_at ASC
    `).all(dateStr) as { url: string; last_seen_at: string }[];
    return visits.map(v => formatUrlLine(v.last_seen_at, v.url)).join('\n');
  }
  const lines: string[] = [];
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

function formatUrlLine(ts: string, url: string): string {
  // ts is a SQLite UTC datetime ('YYYY-MM-DD HH:MM:SS'). Parse as UTC then
  // emit the local HH:MM so claude sees the user's wall-clock time, not
  // UTC offset by the local timezone.
  const d = parseSqliteUtc(ts);
  if (!d || isNaN(d.getTime())) return `??:?? ${url}`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm} ${url}`;
}

function appendMemoAndImprove(
  prompt: string,
  { globalMemo, improve }: { globalMemo?: string | null; improve?: string | null } = {},
): string {
  const tail: string[] = [];
  if (globalMemo && globalMemo.trim()) {
    tail.push('', '## ユーザの常設メモ (毎回参照)', globalMemo.trim());
  }
  if (improve && improve.trim()) {
    tail.push('', '## このターンだけの改善指示 (最優先)', improve.trim());
  }
  return tail.length > 0 ? `${prompt}\n${tail.join('\n')}` : prompt;
}

export interface GenerateWorkContentArgs {
  db: Db;
  dateStr: string;
  metrics: AggregatedDay;
  globalMemo?: string | null;
  improve?: string | null;
  timeoutMs?: number;
}

/**
 * Stage 1: Sonnet (default) writes 作業内容 from the URL timeline AND infers
 * the day's focused work minutes (tail line `WORK_MINUTES: <int>`). Returns
 * `{ content, workMinutes }` — content is the markdown shown to the user
 * (tail stripped), workMinutes feeds the trends chart.
 *
 * URL 履歴に加えて開発活動 (git commit / Claude Code prompt) も
 * 時系列で渡し、 ブラウザ履歴が薄い日 (スマホ開発等) でも作業時間が
 * 適切に推定されるようにする。
 */
export async function generateWorkContent({
  db, dateStr, metrics, globalMemo, improve, timeoutMs = 180_000,
}: GenerateWorkContentArgs): Promise<WorkMinutesExtraction> {
  const urlList = buildUrlList(db, dateStr);
  const activityList = buildActivityList(metrics.activity);
  // どちらか片方でもシグナルがあれば走らせる (スマホ開発日などは URL が空でも commit がある)。
  if (!urlList.trim() && !activityList.trim()) return { content: '', workMinutes: null };
  const activityCounts = formatActivityCounts(metrics.activity);
  const base = WORK_CONTENT_PROMPT({
    dateStr,
    urlList,
    activityList,
    totalEvents: metrics.total_events,
    totalDomains: metrics.unique_domains,
    activityCounts,
    appsBlock: formatAppsBlock(metrics.apps),
    gamesBlock: formatGamesBlock(metrics.games),
  });
  const prompt = appendMemoAndImprove(base, { globalMemo, improve });
  const raw = await runLlm({ task: 'diary_work', prompt, timeoutMs });
  return extractWorkMinutes(raw);
}

/**
 * Sonnet プロンプトに渡す活動タイムラインを組み立てる。
 * 形式: "HH:MM [git/cc] <短い content>" を時刻昇順で並べる。
 * 上限 800 行 (URL 側と揃える) でトリム — 直近側を残す。
 */
function buildActivityList(activity: ActivitySummary | null | undefined): string {
  if (!activity || !activity.items || activity.items.length === 0) return '';
  // items は listLimit 切り取り済 (frontend 用) なので、 prompt 用には全件欲しい。
  // ただし aggregateDay の listLimit=null 経路 (highlights 用) でないと不足する場合あり。
  // 妥協: items を時刻昇順にし直し、 そのまま渡す。
  const sorted = [...activity.items].sort((a, b) => {
    const at = parseSqliteUtc(a.occurred_at)?.getTime() || 0;
    const bt = parseSqliteUtc(b.occurred_at)?.getTime() || 0;
    return at - bt;
  });
  const lines = sorted.map((it) => {
    const d = parseSqliteUtc(it.occurred_at);
    const hh = d ? String(d.getHours()).padStart(2, '0') : '??';
    const mm = d ? String(d.getMinutes()).padStart(2, '0') : '??';
    const tag = it.kind === 'git_commit' ? 'git'
      : it.kind === 'claude_code_prompt' ? 'cc'
      : it.kind;
    const src = it.source ? ` ${it.source}:` : '';
    const content = (it.content || '').replace(/\s+/g, ' ').slice(0, 160);
    return `${hh}:${mm} [${tag}]${src} ${content}`.trim();
  });
  return lines.slice(-800).join('\n');
}

function formatActivityCounts(activity: ActivitySummary | null | undefined): string | null {
  if (!activity || !activity.total) return null;
  const parts: string[] = [];
  if (activity.kinds.git_commit) parts.push(`git commit ${activity.kinds.git_commit} 件`);
  if (activity.kinds.claude_code_prompt) parts.push(`Claude Code 指示 ${activity.kinds.claude_code_prompt} 件`);
  return parts.join(' / ') || `${activity.total} 件`;
}

export interface GenerateHighlightsArgs {
  dateStr: string;
  workContent: string;
  githubByRepo: GithubByRepo;
  bookmarkSummary: BookmarkSummary;
  digs: DigSummary[];
  notes: string | null | undefined;
  metrics: AggregatedDay;
  globalMemo?: string | null;
  improve?: string | null;
  timeoutMs?: number;
}

/** Stage 3: Opus 1M (default) integrates work content + bookmark count + commits + dig into highlights. */
export async function generateHighlights({
  dateStr, workContent, githubByRepo, bookmarkSummary, digs, notes, metrics,
  globalMemo, improve, timeoutMs = 240_000,
}: GenerateHighlightsArgs): Promise<string> {
  const base = HIGHLIGHTS_PROMPT({
    dateStr, workContent, githubByRepo, bookmarkSummary, digs, notes, metrics,
  });
  const prompt = appendMemoAndImprove(base, { globalMemo, improve });
  return await runLlm({ task: 'diary_highlights', prompt, timeoutMs });
}

export interface GenerateDiaryArgs {
  db: Db;
  dateStr: string;
  metrics: AggregatedDay;
  github?: GithubActivityResult | null;
  notes?: string | null;
}

export interface GenerateDiaryResult {
  workContent: string;
  workMinutes?: number | null;
  githubByRepo: GithubByRepo;
  highlights: string;
  summary: string;
  digs?: DigSummary[];
}

/**
 * Top-level diary generator orchestrating the three stages. Returns the
 * structured pieces; the caller persists them.
 */
export async function generateDiary({
  db, dateStr, metrics, github, notes,
}: GenerateDiaryArgs): Promise<GenerateDiaryResult> {
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
  const summary = composeSummary({ workContent, githubByRepo, highlights, digs, activity: metrics.activity });
  return { workContent, workMinutes, githubByRepo, highlights, summary, digs };
}

function buildBookmarkSummary(metrics: AggregatedDay): BookmarkSummary {
  const created = metrics.bookmarks?.created || [];
  const accessed = metrics.bookmarks?.accessed || [];
  const domSet = new Set<string>();
  for (const b of [...created, ...accessed]) {
    try { domSet.add(new URL(b.url).hostname); } catch { /* ignore */ }
  }
  return {
    created: created.length,
    accessed: accessed.length,
    topDomains: [...domSet].slice(0, 8),
  };
}

interface ComposeSummaryArgs {
  workContent: string;
  githubByRepo: GithubByRepo;
  highlights: string;
  digs: DigSummary[];
  activity: ActivitySummary;
}

function composeSummary({
  workContent, githubByRepo, highlights, digs, activity,
}: ComposeSummaryArgs): string {
  const parts: string[] = [];
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
  if (activity && activity.total > 0) {
    const counts = formatActivityCounts(activity);
    const head = counts ? `合計: ${counts}` : `合計: ${activity.total} 件`;
    // 先頭から最大 10 件をサマリに出す (フル一覧は activity 個別パネルで)。
    const sorted = [...(activity.items || [])].sort((a, b) => {
      const at = parseSqliteUtc(a.occurred_at)?.getTime() || 0;
      const bt = parseSqliteUtc(b.occurred_at)?.getTime() || 0;
      return at - bt;
    }).slice(0, 10);
    const lines = sorted.map((it) => {
      const t = formatLocalHm(it.occurred_at);
      const tag = it.kind === 'git_commit' ? 'git'
        : it.kind === 'claude_code_prompt' ? 'cc'
        : it.kind;
      const src = it.source ? ` ${it.source}:` : '';
      const content = (it.content || '').replace(/\s+/g, ' ').slice(0, 120);
      return `- ${t} [${tag}]${src} ${content}`.trim();
    });
    const tail = (activity.items || []).length > 10
      ? `\n- … ほか ${activity.items.length - 10} 件`
      : '';
    parts.push(`## 開発活動\n${head}\n${lines.join('\n')}${tail}`);
  }
  if (highlights) parts.push(`## ハイライト\n${highlights.trim()}`);
  return parts.join('\n\n');
}

// ── weekly --------------------------------------------------------------

interface WeeklyPromptArgs {
  weekStart: string;
  weekEnd: string;
  dailyBlock: string;
  githubBlock: string;
  totalsBlock: string;
}

const WEEKLY_PROMPT = ({ weekStart, weekEnd, dailyBlock, githubBlock, totalsBlock }: WeeklyPromptArgs): string => [
  `あなたは ${weekStart} から ${weekEnd} までの「週報」を書きます。`,
  '7 日分の日報 + GitHub commit + 定量サマリ (= 週合計の作業時間 / ブックマーク数 / 訪問数 / commit 数 / Claude Code 指示数) から週全体を統合してください。',
  '',
  '出力フォーマット (markdown のみ。 前置き不要):',
  '## 今週やったこと',
  '**2〜3 文以内**の超簡潔サマリ (詳細は書かない、 全体の流れを掴ませる程度)。',
  '## 主な成果',
  '- 箇条書き。 各行は「**(N commit)** プロジェクト名: やったこと」 のように **commit 数を必ず prefix** する。',
  '- 進捗が大きかったプロジェクトを優先 (上位 5 件まで)。',
  '## トピック別',
  '- 学んだこと・調べたこと (作業内容ベース、 1-3 行)',
  '## 来週への引き継ぎ',
  '- 未完了 / フォローアップ (1-3 行)',
  '',
  '出力ルール:',
  '- 創作禁止。 日報と commit に基づくこと',
  '- 数字 (commit 数 / 訪問数 / etc) は提示された定量サマリと一致させる',
  '- リポジトリ名は短く (org/ は省いて末尾のみで OK)',
  '- 全体で **300-500 字程度に収める**こと (短くまとめる)',
  '',
  '## 入力 0: 定量サマリ (この数値は変えない)',
  totalsBlock,
  '',
  '## 入力 1: 日報サマリ (日付ごと)',
  dailyBlock,
  '',
  '## 入力 2: GitHub commit ヒストリ',
  githubBlock,
].join('\n');

export interface DailyDiaryEntry {
  date: string;
  summary?: string | null;
  work_content?: string | null;
  work_minutes?: number | null;
}

export interface WeeklyMetrics {
  /** diary_entries.work_minutes の週合計 (Sonnet 推定値の積み上げ)。 0 = 記録なし */
  work_minutes: number;
  /** 今週中に新規作成された bookmarks (created_at で count) */
  bookmarks: number;
  /** 今週中の visit_events (= 1 訪問 1 行) */
  visit_events: number;
  /** GitHub API から取得した commit 総数 (githubByRepo.total と一致) */
  github_commits: number;
  /** activity_events kind='git_commit' のローカル post-commit 件数 */
  git_commits_local: number;
  /** activity_events kind='claude_code_prompt' の件数 */
  claude_code_prompts: number;
}

function formatWorkTime(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0 分 (記録なし)';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h <= 0) return `${m} 分`;
  return m > 0 ? `${h} 時間 ${m} 分` : `${h} 時間`;
}

function formatTotalsBlock(metrics: WeeklyMetrics): string {
  return [
    `- ⏱ 作業時間 (Sonnet 推定の週合計): ${formatWorkTime(metrics.work_minutes)}`,
    `- 🔖 ブックマーク新規追加: ${metrics.bookmarks} 件`,
    `- 🌐 Web 訪問 (記録分): ${metrics.visit_events} 件`,
    `- 🐙 GitHub commit: ${metrics.github_commits} 件 (API 取得)`,
    `- 💻 ローカル commit (hook): ${metrics.git_commits_local} 件`,
    `- 🤖 Claude Code 指示: ${metrics.claude_code_prompts} 件`,
  ].join('\n');
}

function formatTotalsHeader(weekStart: string, weekEnd: string, metrics: WeeklyMetrics): string {
  return [
    `# 週報 ${weekStart} 〜 ${weekEnd}`,
    '',
    '## 今週の定量サマリ',
    formatTotalsBlock(metrics),
  ].join('\n');
}

export interface GenerateWeeklyArgs {
  weekStart: string;
  weekEnd: string;
  dailyDiaries: DailyDiaryEntry[];
  githubByRepo: GithubByRepo;
  metrics: WeeklyMetrics;
  timeoutMs?: number;
}

/**
 * Generate a weekly narrative from 7 daily diaries + commits + 定量メトリクス。
 * 出力には冒頭に「定量サマリ (deterministic)」 を必ず含み、 LLM はその下に
 * 短いナラティブ (今週やったこと / 主な成果 / トピック / 引き継ぎ) を書く。
 */
export async function generateWeekly({
  weekStart, weekEnd, dailyDiaries, githubByRepo, metrics, timeoutMs = 360_000,
}: GenerateWeeklyArgs): Promise<string> {
  const dailyBlock = dailyDiaries.map((d) => {
    const head = d.summary || d.work_content || '(日報なし)';
    const wm = d.work_minutes != null && d.work_minutes > 0 ? ` [${formatWorkTime(d.work_minutes)}]` : '';
    return `### ${d.date}${wm}\n${(head || '').slice(0, 1200)}`;
  }).join('\n\n');
  const githubBlock = githubByRepo.repos.length
    ? githubByRepo.repos.map((r) => {
      const samples = (r.samples || []).slice(0, 6).map((s) => `  - ${s.sha} ${s.message}`).join('\n');
      return `${r.repo}: ${r.count} commits\n${samples}`;
    }).join('\n\n')
    : '(commit なし)';
  const totalsBlock = formatTotalsBlock(metrics);
  const prompt = WEEKLY_PROMPT({ weekStart, weekEnd, dailyBlock, githubBlock, totalsBlock });
  const narrative = await runLlm({ task: 'diary_weekly', prompt, timeoutMs });
  // deterministic な定量サマリ + LLM ナラティブを連結。 万一 LLM が定量見出しを
  // 重ねて出してきた場合に備え、 narrative 側の重複は触らずそのまま残す。
  const header = formatTotalsHeader(weekStart, weekEnd, metrics);
  return `${header}\n\n${narrative.trim()}`;
}

export interface FetchGithubRangeArgs {
  token?: string | null;
  user?: string | null;
  repos?: string[] | null;
  since: string;
  until: string;
  timeoutMs?: number;
}

export interface FetchGithubRangeResult extends GithubByRepo {
  commits: GithubCommit[];
}

/** Fetch a user's commits across `repos` in a date range, grouped by repo. */
export async function fetchGithubRange({
  token, user, repos, since, until, timeoutMs = 60_000,
}: FetchGithubRangeArgs): Promise<FetchGithubRangeResult> {
  if (!user || !repos?.length) return { commits: [], repos: [], total: 0 };
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Memoria-diary/0.1',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const all: GithubCommit[] = [];
  try {
    for (const repo of repos) {
      const url = `https://api.github.com/repos/${repo}/commits`
        + `?author=${encodeURIComponent(user)}`
        + `&since=${encodeURIComponent(since)}`
        + `&until=${encodeURIComponent(until)}`
        + `&per_page=100`;
      const res = await fetch(url, { headers, signal: ac.signal });
      if (!res.ok) continue;
      const arr = await res.json() as GithubApiCommit[];
      for (const c of arr) all.push(formatCommit({ ...c, _repo: repo }));
    }
    return { commits: all, ...summarizeGithubByRepo({ commits: all }) };
  } finally {
    clearTimeout(timer);
  }
}

/** YYYY-MM-DD in local time for a given Date instance (or now). */
export function formatLocalDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Date string for "yesterday" relative to the supplied moment. */
export function yesterdayLocal(now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return formatLocalDate(d);
}

/** Monday → Sunday inclusive range that contains `dateStr`. */
export function weekRangeFor(dateStr: string): { start: string; end: string } {
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
export function weekOfMonth(weekStart: string): { month: string; weekInMonth: number } {
  const d = new Date(weekStart + 'T00:00:00');
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  // Find first Monday in the month containing weekStart's Monday.
  const firstDay = new Date(d.getFullYear(), d.getMonth(), 1);
  const dow = firstDay.getDay();
  const firstMon = new Date(firstDay);
  firstMon.setDate(1 + ((dow === 0 ? 1 : (8 - dow) % 7)));
  const diffDays = Math.round((d.getTime() - firstMon.getTime()) / 86400000);
  const idx = Math.floor(diffDays / 7) + 1;
  return { month, weekInMonth: idx };
}
