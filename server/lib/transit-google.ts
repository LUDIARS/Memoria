// Google Directions API (mode=transit) + Places Autocomplete を使った経路
// 検索 client。 Ekispert を free 廃止に伴い差し替え。
//
// 利点:
//   - Directions API は real-time の遅延を arrival_time / departure_time に
//     反映するので「遅延加味した到着時刻」 をそのまま受け取れる
//   - Memoria は既に maps.api_key を持っているので追加 key 不要
//   - 駅 + バス停 + ロケーション識別を Places の place_id 1 種で済む
//
// 必要な GCP API:
//   - Directions API
//   - Places API (New) — Autocomplete + searchNearby
// Memoria が既に有効化している Places は (New) なので同じ key で行ける。

const DIRECTIONS_URL = 'https://maps.googleapis.com/maps/api/directions/json';
const PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const FETCH_TIMEOUT_MS = 15_000;

export interface GoogleTransitConfig { apiKey: string }

// ── Places Autocomplete (= 駅検索) ───────────────────────────────────────

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
  /** Directions の origin/destination にそのまま 「place_id:xxx」 で渡せる ID */
  code: string;
  name: string;
  /** 主に駅 + 都道府県名 等 */
  secondary?: string;
}

/**
 * 駅 / バス停を Places Autocomplete で検索。
 *
 * includedPrimaryTypes で交通拠点系だけに絞り、 ノイズ (= ランドマーク等) を
 * 除外。 region=jp + language=ja で日本語結果。
 */
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

// ── Directions (= 経路検索 with delay-aware arrival) ────────────────────

export type SearchTimeMode = 'departure' | 'arrival';

export interface SearchInput {
  /** Station.code (= "place_id:xxx") or 駅名/住所文字列 */
  origin: string;
  destination: string;
  /** 既定 = 'departure' = 「いま出発」。 'arrival' は到着時刻指定。 */
  timeMode?: SearchTimeMode;
  /** ローカル時刻 (Date)。 未指定なら 'now'。 */
  when?: Date;
  /** 既定 5 件 (Directions の alternatives) */
  resultCount?: number;
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
  /** TRANSIT / WALKING / BICYCLING / DRIVING */
  travel_mode: string;
}

export interface SearchCourse {
  duration_min: number;
  fare_yen: number;
  transfer_count: number;
  segments: SearchSegment[];
  /** Directions が返した警告文 (= 遅延 / 運休のヒントが入ることがある) */
  warnings: string[];
  /** warnings に遅延キーワードがあった場合 true (UI で⚠ バッジ用) */
  has_delay_hint: boolean;
  /** 全体の出発/到着時刻 (leg[0].departure_time / leg[-1].arrival_time)。
   *  これは Google 側で「real-time の遅延を加味した予想」 を返すので、 静的時刻表
   *  との差分を見るとオンタイムかが分かる。 */
  departure_at: string | null;
  arrival_at: string | null;
}

interface DirectionsResponse {
  status?: string;
  error_message?: string;
  routes?: DirectionsRoute[];
}
interface DirectionsRoute {
  summary?: string;
  legs?: DirectionsLeg[];
  warnings?: string[];
  fare?: { currency?: string; value?: number; text?: string };
}
interface DirectionsLeg {
  duration?: { value?: number; text?: string };
  departure_time?: { value?: number; text?: string; time_zone?: string };
  arrival_time?: { value?: number; text?: string; time_zone?: string };
  start_address?: string;
  end_address?: string;
  steps?: DirectionsStep[];
}
interface DirectionsStep {
  travel_mode?: string;
  duration?: { value?: number };
  transit_details?: {
    departure_stop?: { name?: string };
    arrival_stop?: { name?: string };
    line?: {
      name?: string;
      short_name?: string;
      vehicle?: { type?: string; name?: string };
      agencies?: Array<{ name?: string }>;
    };
    headsign?: string;
    num_stops?: number;
    departure_time?: { value?: number; text?: string };
    arrival_time?: { value?: number; text?: string };
  };
  html_instructions?: string;
}

function epochToIsoSeconds(epochSec: number | undefined): string | null {
  if (!epochSec || !Number.isFinite(epochSec)) return null;
  return new Date(epochSec * 1000).toISOString();
}

function detectDelayHint(warnings: string[]): boolean {
  return warnings.some((w) => /遅延|運休|見合わせ|delay|disrupt|reduced/i.test(w));
}

function normalizeRoute(r: DirectionsRoute): SearchCourse {
  const legs = r.legs ?? [];
  const segments: SearchSegment[] = [];
  let transferCount = -1;       // walk は数えず、 transit step を 1 つずつ
  for (const leg of legs) {
    for (const step of leg.steps ?? []) {
      const td = step.transit_details;
      if (!td) {
        // 徒歩 / その他 (segments に出すかは要否しだいだが、 表示は欲しいので残す)
        if (step.travel_mode === 'WALKING') {
          segments.push({
            line: '徒歩',
            train_type: '',
            from_station: leg.start_address ?? '',
            to_station: leg.end_address ?? '',
            departure_at: null, arrival_at: null,
            travel_mode: 'WALKING',
          });
        }
        continue;
      }
      transferCount++;
      segments.push({
        line: td.line?.name ?? td.line?.short_name ?? '電車',
        company: td.line?.agencies?.[0]?.name,
        train_type: td.line?.vehicle?.name,
        from_station: td.departure_stop?.name ?? '',
        to_station: td.arrival_stop?.name ?? '',
        departure_at: epochToIsoSeconds(td.departure_time?.value),
        arrival_at: epochToIsoSeconds(td.arrival_time?.value),
        num_stops: td.num_stops,
        headsign: td.headsign,
        travel_mode: 'TRANSIT',
      });
    }
  }
  if (transferCount < 0) transferCount = 0;
  const totalSec = legs.reduce((acc, l) => acc + (l.duration?.value ?? 0), 0);
  const fare_yen = r.fare?.currency === 'JPY' ? Math.round(r.fare.value ?? 0) : 0;
  const warnings = r.warnings ?? [];
  return {
    duration_min: Math.round(totalSec / 60),
    fare_yen,
    transfer_count: transferCount,
    segments,
    warnings,
    has_delay_hint: detectDelayHint(warnings),
    departure_at: epochToIsoSeconds(legs[0]?.departure_time?.value),
    arrival_at: epochToIsoSeconds(legs[legs.length - 1]?.arrival_time?.value),
  };
}

/** Directions で経路検索。 Google 側で real-time delay 反映済の時刻が返る。 */
export async function searchRoutes(cfg: GoogleTransitConfig, input: SearchInput): Promise<SearchCourse[]> {
  if (!cfg.apiKey) throw new Error('maps.api_key 未設定');
  if (!input.origin || !input.destination) throw new Error('origin / destination 必須');
  const params = new URLSearchParams({
    origin: input.origin,
    destination: input.destination,
    mode: 'transit',
    language: 'ja',
    region: 'jp',
    alternatives: 'true',
    key: cfg.apiKey,
  });
  // Google は departure_time / arrival_time に epoch sec を要求。
  // 「now」 は departure_time=now で渡せる。 mode=transit でデフォルト = now。
  if (input.timeMode === 'arrival' && input.when) {
    params.set('arrival_time', String(Math.floor(input.when.getTime() / 1000)));
  } else if (input.when) {
    params.set('departure_time', String(Math.floor(input.when.getTime() / 1000)));
  } else {
    params.set('departure_time', 'now');
  }
  const url = `${DIRECTIONS_URL}?${params.toString()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`directions: ${res.status} ${res.statusText}`);
  const j = await res.json() as DirectionsResponse;
  if (j.status && j.status !== 'OK' && j.status !== 'ZERO_RESULTS') {
    throw new Error(`directions: ${j.status}${j.error_message ? `: ${j.error_message}` : ''}`);
  }
  return (j.routes ?? []).map(normalizeRoute);
}
