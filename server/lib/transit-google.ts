// Google Routes API v2 (mode=TRANSIT) を使った経路検索 client。
//
// 旧 Directions API は 2024 年以降 legacy 扱いで、 新規プロジェクトでは
// 既定で disabled (= REQUEST_DENIED)。 Routes API に切替済。
//   POST https://routes.googleapis.com/directions/v2:computeRoutes
//
// 利点:
//   - real-time の遅延を arrival_time に反映 (Routes も同様)
//   - 駅 / バス停 / 住所 / lat,lng どれでも origin/destination に渡せる
//   - Memoria 既存の maps.api_key を流用
//
// 必要な GCP API:
//   - Routes API (= 新規)
//   - Places API (New) — Memoria 既存 (autocomplete + searchNearby)
// Memoria が既に Places (New) を使っているので、 Routes API を additionally
// 有効化すれば同じ key で行ける。
//
// 注意: Routes API は X-Goog-FieldMask header が必須。 これを忘れると 400。

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const FETCH_TIMEOUT_MS = 15_000;

export interface GoogleTransitConfig { apiKey: string }

// ── Places Autocomplete (= 駅検索 fallback) ───────────────────────────────
//
// 通常は HeartRails 由来のローカル DB で駅検索する (= /api/transit/stations/local)。
// この関数は Places (New) の Autocomplete を叩く fallback / 互換 API。
// ローカル DB に当たらない場合 (海外、 住所等) の救済として残す。

interface PlacesAutocompleteResponse {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: {
        mainText?: { text?: string };
        secondaryText?: { text?: string };
      };
    };
  }>;
}

export interface Station {
  /** Routes の origin/destination にそのまま 「place_id:xxx」 で渡せる ID */
  code: string;
  name: string;
  secondary?: string;
}

export async function searchStations(cfg: GoogleTransitConfig, q: string): Promise<Station[]> {
  if (!cfg.apiKey) throw new Error('maps.api_key 未設定 (設定 → AI / 連携 から登録)');
  if (!q.trim()) return [];
  const body = {
    input: q.trim(),
    languageCode: 'ja',
    regionCode: 'JP',
    includedPrimaryTypes: ['train_station', 'subway_station', 'transit_station', 'bus_station', 'light_rail_station'],
  };
  const res = await fetch(PLACES_AUTOCOMPLETE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': cfg.apiKey,
      'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`places autocomplete: ${res.status} ${t.slice(0, 200)}`);
  }
  const j = await res.json() as PlacesAutocompleteResponse;
  return (j.suggestions ?? [])
    .filter((s) => !!s.placePrediction?.placeId)
    .map((s) => {
      const p = s.placePrediction!;
      const main = p.structuredFormat?.mainText?.text;
      const secondary = p.structuredFormat?.secondaryText?.text;
      return {
        code: `place_id:${p.placeId}`,
        name: main ?? p.text?.text ?? '',
        secondary,
      };
    });
}

// ── Routes API: 経路検索 with delay-aware arrival ───────────────────────

export type SearchTimeMode = 'departure' | 'arrival';

export interface SearchInput {
  /** "lat,lng" / "place_id:xxx" / 駅名/住所文字列 のいずれか */
  origin: string;
  destination: string;
  timeMode?: SearchTimeMode;
  when?: Date;
}

export interface SearchSegment {
  line: string;
  company?: string;
  train_type?: string;
  from_station: string;
  to_station: string;
  departure_at: string | null;
  arrival_at: string | null;
  num_stops?: number;
  headsign?: string;
  /** TRANSIT / WALK / BICYCLE / DRIVE */
  travel_mode: string;
}

export interface SearchCourse {
  duration_min: number;
  fare_yen: number;
  transfer_count: number;
  segments: SearchSegment[];
  warnings: string[];
  has_delay_hint: boolean;
  departure_at: string | null;
  arrival_at: string | null;
}

// 「lat,lng」 / 「place_id:xxx」 / 自由テキスト を Routes API 用 Waypoint に変換。
interface RoutesWaypoint {
  location?: { latLng: { latitude: number; longitude: number } };
  placeId?: string;
  address?: string;
}

function buildWaypoint(s: string): RoutesWaypoint {
  const text = s.trim();
  // "lat,lng" — 小数を含む 2 値カンマ区切り
  const m = text.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    const lat = Number(m[1]); const lng = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { location: { latLng: { latitude: lat, longitude: lng } } };
    }
  }
  // "place_id:xxx"
  if (text.startsWith('place_id:')) return { placeId: text.slice('place_id:'.length) };
  // それ以外は自由住所 — Routes が内部 geocode
  return { address: text };
}

// Routes 応答型 (= REST 仕様の JSON)
interface RoutesResponse {
  routes?: RoutesRoute[];
  error?: { message?: string; status?: string; code?: number };
}
interface RoutesRoute {
  duration?: string;            // "1234s"
  staticDuration?: string;
  distanceMeters?: number;
  legs?: RoutesLeg[];
  warnings?: string[];
  description?: string;
  travelAdvisory?: { fareInfo?: { currency?: string; units?: string; nanos?: number } };
  /** 全 leg にまたがる出発 / 到着時刻 (overview) */
  startLocation?: { latLng?: { latitude?: number; longitude?: number } };
  endLocation?: { latLng?: { latitude?: number; longitude?: number } };
}
interface RoutesLeg {
  duration?: string;
  startLocation?: { latLng?: { latitude?: number; longitude?: number } };
  endLocation?: { latLng?: { latitude?: number; longitude?: number } };
  steps?: RoutesStep[];
}
interface RoutesStep {
  travelMode?: 'TRANSIT' | 'WALK' | 'BICYCLE' | 'DRIVE' | string;
  duration?: string;
  staticDuration?: string;
  transitDetails?: {
    stopDetails?: {
      arrivalStop?: { name?: string };
      arrivalTime?: string;       // ISO
      departureStop?: { name?: string };
      departureTime?: string;
    };
    localizedValues?: unknown;
    headsign?: string;
    headway?: string;
    transitLine?: {
      agencies?: Array<{ name?: string }>;
      name?: string;
      nameShort?: string;
      color?: string;
      iconUri?: string;
      url?: string;
      vehicle?: {
        name?: { text?: string };
        type?: string;
        iconUri?: string;
      };
    };
    stopCount?: number;
    tripShortText?: string;
  };
}

function parseDurationSec(d: string | undefined): number {
  if (!d) return 0;
  const m = /^(\d+)s$/.exec(d);
  return m ? Number(m[1]) : 0;
}

function detectDelayHint(warnings: string[]): boolean {
  return warnings.some((w) => /遅延|運休|見合わせ|delay|disrupt|reduced/i.test(w));
}

function fareYen(advisory: RoutesRoute['travelAdvisory']): number {
  const fi = advisory?.fareInfo;
  if (!fi || fi.currency !== 'JPY') return 0;
  const units = Number(fi.units ?? 0);
  if (!Number.isFinite(units)) return 0;
  return Math.round(units);
}

function normalizeRoute(r: RoutesRoute): SearchCourse {
  const legs = r.legs ?? [];
  const segments: SearchSegment[] = [];
  let transferCount = -1;
  let firstDepart: string | null = null;
  let lastArrive: string | null = null;

  for (const leg of legs) {
    for (const step of leg.steps ?? []) {
      const td = step.transitDetails;
      if (td) {
        transferCount++;
        const dep = td.stopDetails?.departureTime ?? null;
        const arr = td.stopDetails?.arrivalTime ?? null;
        if (dep && !firstDepart) firstDepart = dep;
        if (arr) lastArrive = arr;
        segments.push({
          line: td.transitLine?.name ?? td.transitLine?.nameShort ?? '電車',
          company: td.transitLine?.agencies?.[0]?.name,
          train_type: td.transitLine?.vehicle?.name?.text,
          from_station: td.stopDetails?.departureStop?.name ?? '',
          to_station: td.stopDetails?.arrivalStop?.name ?? '',
          departure_at: dep,
          arrival_at: arr,
          num_stops: td.stopCount,
          headsign: td.headsign,
          travel_mode: 'TRANSIT',
        });
      } else if (step.travelMode === 'WALK') {
        segments.push({
          line: '徒歩',
          train_type: '',
          from_station: '',
          to_station: '',
          departure_at: null, arrival_at: null,
          travel_mode: 'WALK',
        });
      }
    }
  }
  if (transferCount < 0) transferCount = 0;
  const totalSec = parseDurationSec(r.duration) || legs.reduce((acc, l) => acc + parseDurationSec(l.duration), 0);
  const warnings = r.warnings ?? [];
  return {
    duration_min: Math.round(totalSec / 60),
    fare_yen: fareYen(r.travelAdvisory),
    transfer_count: transferCount,
    segments,
    warnings,
    has_delay_hint: detectDelayHint(warnings),
    departure_at: firstDepart,
    arrival_at: lastArrive,
  };
}

/** Routes API で経路検索。 real-time delay 反映済の時刻が返る。 */
export async function searchRoutes(cfg: GoogleTransitConfig, input: SearchInput): Promise<SearchCourse[]> {
  if (!cfg.apiKey) throw new Error('maps.api_key 未設定');
  if (!input.origin || !input.destination) throw new Error('origin / destination 必須');

  const body: Record<string, unknown> = {
    origin: buildWaypoint(input.origin),
    destination: buildWaypoint(input.destination),
    travelMode: 'TRANSIT',
    computeAlternativeRoutes: true,
    languageCode: 'ja',
    regionCode: 'jp',
  };
  if (input.timeMode === 'arrival' && input.when) {
    body.arrivalTime = input.when.toISOString();
  } else if (input.when) {
    body.departureTime = input.when.toISOString();
  }
  // 「now」 は省略 = サーバ側 now で計算。 Routes は明示 「now」 文字列を受け付けない。

  const fieldMask = [
    'routes.duration',
    'routes.distanceMeters',
    'routes.warnings',
    'routes.description',
    'routes.travelAdvisory.fareInfo',
    'routes.legs.duration',
    'routes.legs.steps.travelMode',
    'routes.legs.steps.duration',
    'routes.legs.steps.transitDetails',
  ].join(',');

  const res = await fetch(ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': cfg.apiKey,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`routes: ${res.status} ${t.slice(0, 300)}`);
  }
  const j = await res.json() as RoutesResponse;
  if (j.error) {
    throw new Error(`routes: ${j.error.status ?? ''}: ${j.error.message ?? ''}`);
  }
  return (j.routes ?? []).map(normalizeRoute);
}
