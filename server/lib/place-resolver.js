/**
 * GPS 点 (lat, lon) を Google API で日本語の場所説明に変換する resolver.
 *
 * 経路:
 *   1. DB の近接 cache (約 10m 以内に既に解決済の点があれば再利用)
 *   2. Places API Nearby Search (radius=20m, language=ja, limit=1) → 施設名 + 住所
 *   3. Reverse Geocoding (language=ja) → 住所だけ
 *   4. 全部失敗 → place_source='failed' で記録 (= 24h は再試行しない)
 *
 * - API key は app_settings の `maps.api_key` か env GOOGLE_MAPS_API_KEY.
 *   key がなければ全件 'failed' で帰す (静かに skip).
 * - server-side 呼び出しなので referrer 制限は効かない. Google Cloud Console で
 *   "Places API (New / Legacy)" + "Geocoding API" を有効化すること.
 * - 日本語化: ja-JP で問い合わせる.
 *
 * 出力: { name?, address?, source: 'places' | 'geocode' | 'cached' | 'failed' }
 */

import {
  findNearbyResolvedPlace,
  findGpsLocationById,
  setGpsPlace,
  listUnresolvedGpsLocations,
  getAppSettings,
} from '../db.js';

const PLACES_RADIUS_M = 20;
const TIMEOUT_MS = 5000;
const NEAR_CACHE_GRID_M = 10;
const PLACES_NEW_URL = 'https://places.googleapis.com/v1/places:searchNearby';

// 直近の API エラーを保持して /api/locations/resolve-debug で覗けるようにする.
// stdout が複数 npm run dev に分散して追えないので、 ここに記録するのが最速.
let lastApiErrors = [];
function recordError(api, info) {
  const entry = { ts: Math.floor(Date.now() / 1000), api, ...info };
  lastApiErrors.unshift(entry);
  if (lastApiErrors.length > 20) lastApiErrors.length = 20;
  console.warn(`[place-resolver] ${api} ${JSON.stringify(info).slice(0, 240)}`);
}
export function getResolverDebug() {
  return { recent_errors: lastApiErrors };
}

/**
 * 場所照合に使う API key を返す.
 * 優先順位:
 *   1. env `MEMORIA_PLACES_API_KEY`  ← server-side 専用 (Referer 制限なし) を入れる場所
 *   2. env `GOOGLE_MAPS_API_KEY`
 *   3. app_settings の `maps.api_key`  ← 通常 Maps JS 用 (Referer 制限あり) なので
 *      Geocoding/Places を呼ぶと REQUEST_DENIED になる. Cloud Console で:
 *        - "Places API (New)" + "Geocoding API" を有効化
 *        - 上の 2 つを許可した Referer 制限なし (or IP 制限) の Server-side key を
 *          MEMORIA_PLACES_API_KEY に入れる
 *      の 2 段階が要る.
 */
function readApiKey(db) {
  const env = process.env.MEMORIA_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (env) return env;
  const settings = getAppSettings(db);
  return settings?.['maps.api_key'] || '';
}

async function fetchWithTimeout(url, init = {}, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      // 新 Places API は 403/400 を返す. Body にエラー詳細があるので拾う.
      let body = '';
      try { body = await res.text(); } catch {}
      recordError('http', { url: maskKey(url), status: res.status, statusText: res.statusText, body: body.slice(0, 400) });
      return null;
    }
    return await res.json();
  } catch (err) {
    recordError('fetch', { url: maskKey(url), error: `${err?.name}: ${err?.message}` });
    return null;
  } finally {
    clearTimeout(t);
  }
}

function maskKey(url) {
  return url.replace(/key=[^&]+/, 'key=***');
}

/**
 * Places API Nearby Search で半径 20m 以内の最も近い 1 件を取る (language=ja).
 * 返り値: { name, address } | null
 */
/**
 * Places API (New) — POST {url}/v1/places:searchNearby.
 * Legacy Places API は段階的に無効化されているため (New) を使う.
 * key は X-Goog-Api-Key header で渡し, 必要 field を X-Goog-FieldMask で指定 (必須).
 */
async function tryPlacesNearby(lat, lon, apiKey) {
  const body = {
    maxResultCount: 1,
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lon },
        radius: PLACES_RADIUS_M,
      },
    },
    languageCode: 'ja',
    regionCode: 'JP',
  };
  const j = await fetchWithTimeout(PLACES_NEW_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.shortFormattedAddress',
    },
    body: JSON.stringify(body),
  });
  if (!j) return null;
  const r = j.places?.[0];
  if (!r) return null;
  const name = r.displayName?.text ?? null;
  // shortFormattedAddress は (New) で 短い表記 (例: "東京都渋谷区..."), なければ formattedAddress.
  const address = r.shortFormattedAddress ?? r.formattedAddress ?? null;
  return { name, address };
}

/**
 * Reverse Geocoding で住所文字列を取る (language=ja).
 * 返り値: { address } | null
 */
async function tryReverseGeocode(lat, lon, apiKey) {
  const url =
    `https://maps.googleapis.com/maps/api/geocode/json` +
    `?latlng=${lat},${lon}` +
    `&language=ja&result_type=street_address|premise|point_of_interest|establishment` +
    `&key=${encodeURIComponent(apiKey)}`;
  let j = await fetchWithTimeout(url);
  // 細かい result_type で取れなければ全タイプで再取得
  if (!j || j.status !== 'OK' || !j.results?.length) {
    const url2 =
      `https://maps.googleapis.com/maps/api/geocode/json` +
      `?latlng=${lat},${lon}&language=ja&key=${encodeURIComponent(apiKey)}`;
    j = await fetchWithTimeout(url2);
  }
  if (!j) return null;
  if (j.status !== 'OK') {
    if (j.status === 'ZERO_RESULTS') return null;
    recordError('geocode', { status: j.status, error_message: j.error_message ?? '' });
    return null;
  }
  const r = j.results?.[0];
  if (!r?.formatted_address) return null;
  // "日本、〒351-0036 埼玉県朝霞市膝折町..." の先頭の "日本、" を削るとシンプル.
  const addr = r.formatted_address.replace(/^日本、\s*/, '');
  return { address: addr };
}

/**
 * 1 点を解決. DB cache → Places → Geocode の順.
 * 結果を gps_locations に書き込み, 出力 dict を返す.
 */
export async function resolvePlaceForRow(db, row) {
  const { id, lat, lon } = row;
  // 既に解決済なら何もしない
  const cur = findGpsLocationById(db, id);
  if (!cur) return { source: 'failed', reason: 'not_found' };
  if (cur.place_resolved_at) return { source: 'cached', reused: true };

  // 1. 近接 cache
  const near = findNearbyResolvedPlace(db, lat, lon, NEAR_CACHE_GRID_M);
  if (near && (near.place_name || near.place_address)) {
    setGpsPlace(db, id, { name: near.place_name, address: near.place_address, source: 'cached' });
    return { name: near.place_name, address: near.place_address, source: 'cached' };
  }

  // 2/3. API
  const apiKey = readApiKey(db);
  if (!apiKey) {
    setGpsPlace(db, id, { name: null, address: null, source: 'failed' });
    return { source: 'failed', reason: 'no_api_key' };
  }
  const places = await tryPlacesNearby(lat, lon, apiKey);
  if (places && (places.name || places.address)) {
    setGpsPlace(db, id, { name: places.name, address: places.address, source: 'places' });
    return { ...places, source: 'places' };
  }
  const geo = await tryReverseGeocode(lat, lon, apiKey);
  if (geo?.address) {
    setGpsPlace(db, id, { name: null, address: geo.address, source: 'geocode' });
    return { ...geo, source: 'geocode' };
  }
  setGpsPlace(db, id, { name: null, address: null, source: 'failed' });
  return { source: 'failed' };
}

/**
 * 未解決の点をまとめて解決. rate limit 対策に各リクエスト間 stepMs ms 空ける.
 * onResolved(id, result) callback で 1 件ずつ通知 (WS broadcast 用).
 */
export async function resolveUnresolvedBatch(db, { limit = 50, stepMs = 150, onResolved } = {}) {
  const rows = listUnresolvedGpsLocations(db, limit);
  let ok = 0, failed = 0;
  for (const row of rows) {
    const r = await resolvePlaceForRow(db, row);
    if (r.source === 'failed') failed++; else ok++;
    if (onResolved) {
      try { onResolved(row.id, r); } catch { /* swallow */ }
    }
    if (stepMs > 0) await new Promise(res => setTimeout(res, stepMs));
  }
  return { processed: rows.length, ok, failed };
}
