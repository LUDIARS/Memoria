import type BetterSqlite3 from 'better-sqlite3';
import type { SpendingLogRecord } from './contract.js';

type Db = BetterSqlite3.Database;

/**
 * spending log (レシート / クレカ) を GPS 軌跡と突き合わせ、 滞在記録を補強する。
 *
 * GPS だけでは「そこに居た」ことしか分からず、 店名も目的も残らない。 逆にクレカ明細だけでは
 * 時刻や座標が欠けることがある。 日付 + 時刻 + 座標 / 店名で両者を突き合わせ、 どちらが
 * どちらを裏付けたかを status として明示する。 推測で埋めることはしない。
 */

/** 支出時刻から前後どれだけの GPS 点を突合対象にするか。 */
const TIME_WINDOW_MS = 30 * 60 * 1000;
/** 同一地点と見なす距離。 店舗規模と GPS 誤差を踏まえた値。 */
const SAME_PLACE_RADIUS_M = 300;
/** これを超えて離れていれば、 同じ時刻に別の場所に居たことになるので矛盾として出す。 */
const CONFLICT_RADIUS_M = 2000;

export type StayMatchStatus =
  /** 支出座標と GPS 点が近接。 滞在が二重に裏付けられた。 */
  | 'confirmed_by_gps'
  /** 支出側に座標が無く、 時刻の一致だけで GPS 点を対応付けた。 */
  | 'time_matched'
  /** 同時刻の GPS 点が遠い。 カード決済 (通販 / 後日計上) の可能性。 */
  | 'conflict'
  /** 窓内に GPS 点が無い。 */
  | 'no_gps';

interface MatchedGpsPoint {
  recorded_at: string;
  place_name: string | null;
}

interface GpsPoint extends MatchedGpsPoint {
  lat: number;
  lon: number;
  accuracy_m: number | null;
}

export interface StayEvidence {
  record_id: string;
  date: string;
  occurred_at: string | null;
  source_kind: SpendingLogRecord['source_kind'];
  amount: number;
  currency: string;
  place_name: string | null;
  google_maps_url: string | null;
  status: StayMatchStatus;
  nearest_gps: MatchedGpsPoint | null;
  distance_m: number | null;
  /** GPS 側に場所名が無く、 支出側の店名で補強できる場合だけ入る。 */
  enriched_place_name: string | null;
}

export interface DailyStayTimeline {
  date: string;
  entries: StayEvidence[];
  confirmed_count: number;
  conflict_count: number;
}

export function buildStayEvidence(
  db: Db,
  records: SpendingLogRecord[],
  { userId = 'me' }: { userId?: string } = {},
): StayEvidence[] {
  const selectTimedPoints = db.prepare(`
    SELECT recorded_at, lat, lon, accuracy_m, place_name
      FROM gps_locations
     WHERE user_id = @user_id
       AND recorded_at >= @from AND recorded_at <= @to
     ORDER BY recorded_at ASC
  `);
  const selectDayPoints = db.prepare(`
    SELECT recorded_at, lat, lon, accuracy_m, place_name
      FROM gps_locations
     WHERE user_id = @user_id
       AND date(recorded_at, 'localtime') = @date
     ORDER BY recorded_at ASC
  `);

  return records.map((record) => {
    const anchor = record.occurred_at ?? null;
    const window = anchor ? isoWindow(anchor, TIME_WINDOW_MS) : null;
    if (anchor && !window) return noGpsEvidence(record);
    const points = (window
      ? selectTimedPoints.all({ user_id: userId, from: window.from, to: window.to })
      : selectDayPoints.all({ user_id: userId, date: record.date })) as GpsPoint[];
    if (points.length === 0) return noGpsEvidence(record);

    const spendLocation = record.place.location;
    if (!spendLocation) {
      const nearestInTime = anchor ? nearestByTime(points, anchor) : points[0];
      return {
        ...baseEvidence(record),
        status: 'time_matched',
        nearest_gps: publicGpsPoint(nearestInTime),
        distance_m: null,
        enriched_place_name: nearestInTime.place_name ? null : record.place.name,
      };
    }

    const ranked = points
      .map((point) => ({
        point,
        distance: haversineMeters(spendLocation.latitude, spendLocation.longitude, point.lat, point.lon),
      }))
      .sort((a, b) => a.distance - b.distance);
    const best = ranked[0];
    const status: StayMatchStatus = best.distance <= SAME_PLACE_RADIUS_M
      ? 'confirmed_by_gps'
      : best.distance >= CONFLICT_RADIUS_M
        ? 'conflict'
        : 'time_matched';

    return {
      ...baseEvidence(record),
      status,
      nearest_gps: publicGpsPoint(best.point),
      distance_m: Math.round(best.distance),
      enriched_place_name: status === 'confirmed_by_gps' && !best.point.place_name
        ? record.place.name
        : null,
    };
  });
}

export function groupStaysByDate(evidence: StayEvidence[]): DailyStayTimeline[] {
  const days = new Map<string, DailyStayTimeline>();
  for (const entry of evidence) {
    const day = days.get(entry.date)
      ?? { date: entry.date, entries: [] as StayEvidence[], confirmed_count: 0, conflict_count: 0 };
    day.entries.push(entry);
    if (entry.status === 'confirmed_by_gps') day.confirmed_count += 1;
    if (entry.status === 'conflict') day.conflict_count += 1;
    days.set(entry.date, day);
  }
  return [...days.values()]
    .map((day) => ({
      ...day,
      entries: [...day.entries].sort((a, b) => (a.occurred_at ?? '').localeCompare(b.occurred_at ?? '')),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function baseEvidence(record: SpendingLogRecord): Omit<StayEvidence, 'status' | 'nearest_gps' | 'distance_m' | 'enriched_place_name'> {
  return {
    record_id: record.id,
    date: record.date,
    occurred_at: record.occurred_at,
    source_kind: record.source_kind,
    amount: record.amount,
    currency: record.currency,
    place_name: record.place.name,
    google_maps_url: record.place.google_maps_url,
  };
}

function noGpsEvidence(record: SpendingLogRecord): StayEvidence {
  return {
    ...baseEvidence(record),
    status: 'no_gps',
    nearest_gps: null,
    distance_m: null,
    enriched_place_name: null,
  };
}

function nearestByTime(points: GpsPoint[], anchorIso: string): GpsPoint {
  const anchor = Date.parse(anchorIso);
  return points.reduce((best, point) => {
    const bestDelta = Math.abs(Date.parse(best.recorded_at) - anchor);
    const delta = Math.abs(Date.parse(point.recorded_at) - anchor);
    return delta < bestDelta ? point : best;
  }, points[0]);
}

function publicGpsPoint(point: GpsPoint): MatchedGpsPoint {
  return { recorded_at: point.recorded_at, place_name: point.place_name };
}

function isoWindow(anchorIso: string, windowMs: number): { from: string; to: string } | null {
  const anchor = Date.parse(anchorIso);
  if (Number.isNaN(anchor)) return null;
  return {
    from: new Date(anchor - windowMs).toISOString(),
    to: new Date(anchor + windowMs).toISOString(),
  };
}

const EARTH_RADIUS_M = 6_371_000;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}
