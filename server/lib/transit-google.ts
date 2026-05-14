// Google Places (New) Autocomplete を使った駅検索 fallback。
//
// 経路探索はもう Google API では行わない:
//   - 旧 Directions API は legacy 扱いで新規プロジェクトは disabled
//   - 新 Routes API は 日本の鉄道 (TRANSIT mode) に非対応 (= 常に 0 件)
// → frontend が Google Maps へ deep-link する方式に変更済。
//
// このモジュールに残るのは 「駅名検索の fallback」 だけ。 通常は HeartRails 由来の
// ローカル DB (transit-stations-seed.ts) で駅検索するが、 ローカルに当たらない
// (海外駅 / 住所等) ときの保険として Places Autocomplete を残す。
//
// 認証: Memoria 既存の maps.api_key を流用 (= server-side は MEMORIA_PLACES_API_KEY
// env が必要、 referer 制限ありの browser key だと 403)。

const PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const FETCH_TIMEOUT_MS = 15_000;

export interface GoogleTransitConfig { apiKey: string }

// ── 経路セグメント型 ──────────────────────────────────────────────────────
//
// 乗車記録 (transit_rides) の segments_json で使う共通型。 経路探索 API は
// 廃止したが、 手動入力 / GPS 自動検出した ride も将来 segment を持てるよう
// 型は残す。

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

// ── Places Autocomplete (= 駅検索 fallback) ───────────────────────────────

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
  /** Place ID。 ローカル DB ヒット時は使わない (= 表示名のみ使う)。 */
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
